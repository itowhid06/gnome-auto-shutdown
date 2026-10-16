import GLib from 'gi://GLib';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

export const MAX_DELAY_MINUTES = 99 * 60 + 59;

/**
 * "10 minutes", "1 hour", "1 hour 30 minutes".
 *
 * @param {number} totalMinutes
 */
export function formatDuration(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const hoursText = ngettext('%d hour', '%d hours', hours).replace('%d', hours);
    const minutesText = ngettext('%d minute', '%d minutes', minutes).replace('%d', minutes);

    if (hours && minutes)
        /* Translators: hours followed by minutes, e.g. "1 hour 30 minutes" */
        return _('%1$s %2$s').replace('%1$s', hoursText).replace('%2$s', minutesText);

    return hours ? hoursText : minutesText;
}

/**
 * Compact remaining time for the menu: "1 h 05 min", "12 min", "45 s".
 *
 * @param {number} seconds
 */
export function formatRemaining(seconds) {
    seconds = Math.max(0, Math.ceil(seconds));

    if (seconds < 60)
        return _('%d s').replace('%d', seconds);

    const totalMinutes = Math.ceil(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0)
        return _('%d min').replace('%d', minutes);

    return _('%1$d h %2$s min')
        .replace('%1$d', hours)
        .replace('%2$s', String(minutes).padStart(2, '0'));
}

/**
 * Panel countdown: "9:59", "1:05:12".
 *
 * @param {number} seconds
 */
export function formatCountdown(seconds) {
    seconds = Math.max(0, Math.ceil(seconds));

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const secs = String(seconds % 60).padStart(2, '0');

    if (hours)
        return `${hours}:${String(minutes).padStart(2, '0')}:${secs}`;

    return `${minutes}:${secs}`;
}

/**
 * Clock time of a deadline relative to today: "at 14:30", "tomorrow at 2:30 PM",
 * "on Mon 20 Oct at 14:30".
 *
 * @param {number} deadline CLOCK_REALTIME microseconds
 * @param {boolean} use12h follow the desktop's 12-hour clock setting
 */
export function formatDeadline(deadline, use12h) {
    const time = GLib.DateTime.new_from_unix_local(Math.floor(deadline / GLib.USEC_PER_SEC));
    const now = GLib.DateTime.new_now_local();
    const clock = time.format(use12h ? '%l:%M %p' : '%H:%M').trim();
    const days = dayNumber(time) - dayNumber(now);

    if (days <= 0)
        return _('at %s').replace('%s', clock);

    if (days === 1)
        return _('tomorrow at %s').replace('%s', clock);

    return _('on %1$s at %2$s')
        .replace('%1$s', time.format('%a %e %b').replace(/\s+/g, ' ').trim())
        .replace('%2$s', clock);
}

function dayNumber(dateTime) {
    const local = GLib.DateTime.new_utc(
        dateTime.get_year(), dateTime.get_month(), dateTime.get_day_of_month(), 0, 0, 0);
    return Math.round(local.to_unix() / 86400);
}

/**
 * Sanitizes an `ai` minutes list from GSettings: positive, unique, in range.
 *
 * @param {number[]} values
 */
export function cleanMinutes(values) {
    return [...new Set(values.filter(v => Number.isInteger(v) && v > 0 && v <= MAX_DELAY_MINUTES))];
}
