// Modal dialog for choosing any delay ("in 2 h 15 min") or a time of day ("at 23:30").

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MAX_DELAY_MINUTES, formatDeadline, formatDuration, formatRemaining} from './util.js';

const Mode = Object.freeze({
    DELAY: 'delay',
    CLOCK: 'clock',
});

/**
 * A two-digit number entry with −/+ buttons, arrow-key and scroll support.
 * Stepping past either end wraps around and reports a carry to `onWrap`,
 * which can refuse it (the value is then clamped instead).
 */
class NumberField {
    constructor({title, max, step, onChanged, onActivate, onWrap}) {
        this._max = max;
        this._step = step;
        this._value = 0;
        this._updating = false;
        this._onChanged = onChanged;
        this._onWrap = onWrap;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'auto-shutdown-field',
            x_expand: true,
        });

        this._title = new St.Label({
            text: title,
            style_class: 'auto-shutdown-field-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._title);

        const row = new St.BoxLayout({
            style_class: 'auto-shutdown-field-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(row);

        const down = this._makeStepButton('list-remove-symbolic', _('Decrease'));
        down.connect('clicked', () => this.stepBy(-1));
        row.add_child(down);

        this.entry = new St.Entry({
            style_class: 'auto-shutdown-entry',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.entry.clutter_text.set({
            max_length: 2,
            input_purpose: Clutter.InputContentPurpose.DIGITS,
            x_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this.entry);

        const up = this._makeStepButton('list-add-symbolic', _('Increase'));
        up.connect('clicked', () => this.stepBy(1));
        row.add_child(up);

        const text = this.entry.clutter_text;
        text.connect('text-changed', () => this._onTextChanged());
        text.connect('activate', () => onActivate());
        text.connect('key-focus-out', () => this._showValue());
        text.connect('key-press-event', (_actor, event) => {
            switch (event.get_key_symbol()) {
            case Clutter.KEY_Up:
            case Clutter.KEY_KP_Up:
                this.stepBy(1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
            case Clutter.KEY_KP_Down:
                this.stepBy(-1);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
            }
        });

        this.actor.connect('scroll-event', (_actor, event) => {
            switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
                this.stepBy(1);
                return Clutter.EVENT_STOP;
            case Clutter.ScrollDirection.DOWN:
                this.stepBy(-1);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
            }
        });
    }

    get value() {
        return this._value;
    }

    setTitle(title) {
        this._title.text = title;
    }

    setMax(max) {
        this._max = max;
        if (this._value > max)
            this.setValue(max);
    }

    setValue(value) {
        this._value = Math.min(Math.max(0, value), this._max);
        this._showValue();
        this._onChanged();
    }

    /**
     * Moves to the next/previous multiple of the step, so 7 → 10 → 15.
     *
     * @param {number} direction 1 or -1
     */
    stepBy(direction) {
        const range = this._max + 1;
        let next = direction > 0
            ? Math.floor(this._value / this._step) * this._step + this._step
            : Math.ceil(this._value / this._step) * this._step - this._step;
        let carry = 0;

        if (next > this._max) {
            next -= range;
            carry = 1;
        } else if (next < 0) {
            next += range;
            carry = -1;
        }

        if (carry && !this._onWrap(carry))
            next = carry > 0 ? this._max : 0;

        this.setValue(next);
    }

    focus() {
        this.entry.grab_key_focus();
        this.entry.clutter_text.set_selection(0, -1);
    }

    _makeStepButton(iconName, accessibleName) {
        return new St.Button({
            style_class: 'icon-button auto-shutdown-step-button',
            can_focus: true,
            accessible_name: accessibleName,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName}),
        });
    }

    _showValue() {
        this._updating = true;
        this.entry.text = String(this._value).padStart(2, '0');
        this._updating = false;
    }

    _onTextChanged() {
        if (this._updating)
            return;

        const text = this.entry.text;
        const digits = text.replace(/\D/g, '');
        let value = digits === '' ? 0 : parseInt(digits, 10);

        if (value > this._max) {
            value = this._max;
            this._value = value;
            this._showValue();
        } else if (digits !== text) {
            this._updating = true;
            this.entry.text = digits;
            this._updating = false;
        }

        this._value = value;
        this._onChanged();
    }
}

export const CustomTimeDialog = GObject.registerClass(
class CustomTimeDialog extends ModalDialog.ModalDialog {
    /**
     * @param {object} params
     * @param {number} params.initialMinutes starting delay
     * @param {boolean} params.use12h display times in 12-hour format
     * @param {Function} params.onSchedule called with (deadlineUsec, delayMinutes|null)
     */
    _init({initialMinutes, use12h, onSchedule}) {
        super._init({styleClass: 'auto-shutdown-dialog'});

        this._use12h = use12h;
        this._onSchedule = onSchedule;
        this._mode = Mode.DELAY;
        this._confirmed = false;
        this._ready = false;

        initialMinutes = Math.min(Math.max(1, initialMinutes), MAX_DELAY_MINUTES);
        this._values = {
            [Mode.DELAY]: [Math.floor(initialMinutes / 60), initialMinutes % 60],
            [Mode.CLOCK]: this._defaultClockTime(initialMinutes),
        };

        const content = new Dialog.MessageDialogContent({
            title: _('Schedule Shutdown'),
            description: _('Choose when the computer should power off.'),
        });
        this.contentLayout.add_child(content);

        const modeBox = new St.BoxLayout({
            style_class: 'auto-shutdown-mode-box',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._delayButton = this._makeModeButton(_('After a Delay'), Mode.DELAY);
        this._clockButton = this._makeModeButton(_('At a Time'), Mode.CLOCK);
        modeBox.add_child(this._delayButton);
        modeBox.add_child(this._clockButton);
        this.contentLayout.add_child(modeBox);

        const fields = new St.BoxLayout({
            style_class: 'auto-shutdown-fields',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._hours = new NumberField({
            title: _('Hours'),
            max: 99,
            step: 1,
            onChanged: () => this._update(),
            onActivate: () => this._confirm(),
            onWrap: () => this._mode === Mode.CLOCK,
        });
        this._minutes = new NumberField({
            title: _('Minutes'),
            max: 59,
            step: 5,
            onChanged: () => this._update(),
            onActivate: () => this._confirm(),
            onWrap: carry => this._carryIntoHours(carry),
        });
        fields.add_child(this._hours.actor);
        fields.add_child(new St.Label({
            text: ':',
            style_class: 'auto-shutdown-separator',
            y_align: Clutter.ActorAlign.END,
        }));
        fields.add_child(this._minutes.actor);
        this.contentLayout.add_child(fields);

        this._summary = new St.Label({
            style_class: 'auto-shutdown-summary',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._summary.clutter_text.line_wrap = true;
        this.contentLayout.add_child(this._summary);

        this.addButton({
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        });
        this._scheduleButton = this.addButton({
            label: _('Schedule'),
            action: () => this._confirm(),
            default: true,
        });

        this._ready = true;
        this._setMode(Mode.DELAY);

        // Keep "in N min" accurate while the dialog stays open.
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        this.connect('destroy', () => {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        });

        this.setInitialKeyFocus(this._minutes.entry);
    }

    open(...args) {
        const opened = super.open(...args);
        if (opened)
            this._minutes.focus();
        return opened;
    }

    _makeModeButton(label, mode) {
        const button = new St.Button({
            label,
            style_class: 'auto-shutdown-mode-button',
            can_focus: true,
            toggle_mode: true,
        });
        button.connect('clicked', () => this._setMode(mode));
        return button;
    }

    _setMode(mode) {
        if (this._mode !== mode)
            this._values[this._mode] = [this._hours.value, this._minutes.value];

        this._mode = mode;
        this._delayButton.checked = mode === Mode.DELAY;
        this._clockButton.checked = mode === Mode.CLOCK;

        const clock = mode === Mode.CLOCK;
        this._hours.setTitle(clock ? _('Hour (0–23)') : _('Hours'));
        this._minutes.setTitle(clock ? _('Minute') : _('Minutes'));
        this._hours.setMax(clock ? 23 : 99);

        const [hours, minutes] = this._values[mode];
        this._ready = false;
        this._hours.setValue(hours);
        this._minutes.setValue(minutes);
        this._ready = true;
        this._update();
    }

    _carryIntoHours(carry) {
        const hours = this._hours.value + carry;

        if (this._mode === Mode.CLOCK) {
            this._hours.setValue((hours + 24) % 24);
            return true;
        }

        if (hours < 0 || hours > 99)
            return false;

        this._hours.setValue(hours);
        return true;
    }

    _defaultClockTime(minutesFromNow) {
        // Round up to the next 5 minutes for a tidy suggestion.
        const target = GLib.DateTime.new_now_local().add_minutes(minutesFromNow + 4);
        const minute = Math.floor(target.get_minute() / 5) * 5;
        return [target.get_hour(), minute];
    }

    /** @returns {{deadline: number, delayMinutes: number|null}|null} */
    _selection() {
        const hours = this._hours.value;
        const minutes = this._minutes.value;
        const now = GLib.DateTime.new_now_local();

        if (this._mode === Mode.DELAY) {
            const delayMinutes = hours * 60 + minutes;
            if (delayMinutes < 1)
                return null;

            return {
                deadline: GLib.get_real_time() + delayMinutes * 60 * GLib.USEC_PER_SEC,
                delayMinutes,
            };
        }

        let target = GLib.DateTime.new_local(
            now.get_year(), now.get_month(), now.get_day_of_month(), hours, minutes, 0);
        if (target.to_unix() <= now.to_unix())
            target = target.add_days(1);

        return {deadline: target.to_unix() * GLib.USEC_PER_SEC, delayMinutes: null};
    }

    _update() {
        if (!this._ready)
            return;

        const selection = this._selection();
        this._scheduleButton.reactive = selection !== null;

        if (!selection) {
            this._summary.text = _('Choose a delay of at least one minute.');
            return;
        }

        const when = formatDeadline(selection.deadline, this._use12h);
        if (selection.delayMinutes !== null) {
            this._summary.text = _('Shuts down in %1$s, %2$s.')
                .replace('%1$s', formatDuration(selection.delayMinutes))
                .replace('%2$s', when);
        } else {
            const seconds = (selection.deadline - GLib.get_real_time()) / GLib.USEC_PER_SEC;
            this._summary.text = _('Shuts down %1$s (in %2$s).')
                .replace('%1$s', when)
                .replace('%2$s', formatRemaining(seconds));
        }
    }

    _confirm() {
        const selection = this._selection();
        if (!selection || this._confirmed)
            return;

        this._confirmed = true;
        this._onSchedule(selection.deadline, selection.delayMinutes);
        this.close();
    }
});
