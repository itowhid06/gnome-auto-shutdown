"""Drives a headless GNOME Shell with the extension loaded. Run via test-headless.sh."""

import json
import os
import subprocess
import sys
import time

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

UUID = os.environ['AUTO_SHUTDOWN_UUID']
EXT_DIR = os.environ['AUTO_SHUTDOWN_EXT_DIR']
OUT = os.environ['AUTO_SHUTDOWN_OUT']
DOCS_DIR = os.environ.get('AUTO_SHUTDOWN_DOCS_DIR')
LOG = os.path.join(OUT, 'gnome-shell.log')
NOTHING = ('', 18446744073709551615)

session = Gio.bus_get_sync(Gio.BusType.SESSION)
system = Gio.bus_get_sync(Gio.BusType.SYSTEM)
failures = []


def gsettings(*args, schema_dir=None):
    env = dict(os.environ)
    if schema_dir:
        env['GSETTINGS_SCHEMA_DIR'] = schema_dir
    subprocess.run(['gsettings', 'set', *args], check=True, env=env)


def logind_schedule():
    reply = system.call_sync(
        'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.DBus.Properties', 'Get',
        GLib.Variant('(ss)', ('org.freedesktop.login1.Manager', 'ScheduledShutdown')),
        GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, None)
    return tuple(reply.unpack()[0])


def logind_cancel():
    system.call_sync(
        'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager',
        'CancelScheduledShutdown', None, GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, -1, None)


def logind_dry_schedule(kind, deadline_us):
    system.call_sync(
        'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager',
        'ScheduleShutdown', GLib.Variant('(st)', (kind, deadline_us)), None,
        Gio.DBusCallFlags.NONE, -1, None)


def shell_eval(code):
    """Evaluates JS in the shell; the code's value is JSON-encoded back."""
    wrapped = f'(() => {{ {code} }})() ?? null'
    reply = session.call_sync(
        'org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
        GLib.Variant('(s)', (wrapped,)), GLib.VariantType('(bs)'), Gio.DBusCallFlags.NONE, 10000, None)
    ok, result = reply.unpack()
    if not ok:
        raise RuntimeError(f'Eval failed: {result}\n--- code ---\n{code}')
    return json.loads(result) if result else None


def screenshot(name, docs_name=None, area=None):
    """Saves a full screenshot to OUT and, with DOCS_DIR set, a cropped one for the README."""
    path = os.path.join(OUT, f'{name}.png')
    session.call_sync(
        'org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot',
        'Screenshot', GLib.Variant('(bbs)', (False, False, path)), GLib.VariantType('(bs)'),
        Gio.DBusCallFlags.NONE, 10000, None)
    print(f'   screenshot: {path}')

    if DOCS_DIR and docs_name:
        docs_path = os.path.join(DOCS_DIR, f'{docs_name}.png')
        session.call_sync(
            'org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot',
            'ScreenshotArea', GLib.Variant('(iiiibs)', (*area, False, docs_path)), GLib.VariantType('(bs)'),
            Gio.DBusCallFlags.NONE, 10000, None)
        print(f'   docs screenshot: {docs_path}')


def check(label, condition, detail=''):
    print(f"  {'PASS' if condition else 'FAIL'}  {label}{f'  ({detail})' if detail else ''}")
    if not condition:
        failures.append(label)


def now_us():
    return int(time.time() * 1_000_000)


IND = f"const ind = Main.panel.statusArea['{UUID}'];"


def wait_for(fn, timeout=10.0, interval=0.25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            value = fn()
            if value:
                return value
        except Exception:  # noqa: BLE001 - shell may still be starting
            pass
        time.sleep(interval)
    return fn()


def main():
    gsettings('org.gnome.shell', 'enabled-extensions', f"['{UUID}', 'test-helper@auto-shutdown']")
    gsettings('org.gnome.shell', 'disable-user-extensions', 'false')
    gsettings('org.gnome.shell', 'welcome-dialog-last-shown-version', "'999'")
    gsettings('org.gnome.desktop.interface', 'enable-animations', 'false')
    gsettings('org.gnome.desktop.interface', 'clock-format', "'24h'")
    for key in ('picture-uri', 'picture-uri-dark'):
        gsettings('org.gnome.desktop.background', key, "''")
    gsettings('org.gnome.desktop.background', 'primary-color', "'#3d4f6b'")
    gsettings('org.gnome.shell.extensions.auto-shutdown', 'dry-run', 'true',
              schema_dir=os.path.join(EXT_DIR, 'schemas'))

    log = open(LOG, 'w')
    shell = subprocess.Popen(
        ['gnome-shell', '--headless', '--wayland', '--no-x11', '--virtual-monitor', '1280x800',
         '--wayland-display', 'wayland-extension-test'],
        stdout=log, stderr=subprocess.STDOUT)

    try:
        run_tests()
    finally:
        try:
            if logind_schedule() != NOTHING:
                logind_cancel()
        finally:
            shell.terminate()
            try:
                shell.wait(10)
            except subprocess.TimeoutExpired:
                shell.kill()
            log.close()

    with open(LOG) as f:
        problems = [line.rstrip() for line in f
                    if ('JS ERROR' in line or 'JS WARNING' in line or 'Auto Shutdown' in line
                        or 'auto-shutdown@' in line or 'Gjs-CRITICAL' in line or 'Gjs-WARNING' in line)]
    check('shell log has no JS errors or warnings from the extension', not problems,
          '\n        '.join([''] + problems[:20]))

    print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}; log: {LOG}")
    sys.exit(1 if failures else 0)


def run_tests():
    print('==> Waiting for headless GNOME Shell')
    ready = wait_for(lambda: shell_eval(f"{IND} return Boolean(ind);"), timeout=40)
    check('extension loaded and indicator added to the top bar', ready)
    if not ready:
        return

    state = shell_eval(f"""{IND}
        Main.overview.hide();
        // Drop the "unsafe mode" banner so it does not hide our notifications.
        Main.messageTray.getSources().forEach(s => s.destroy());
        const ext = Main.extensionManager.lookup('{UUID}');
        return {{state: ext.state, error: ext.error ?? null, dry: ind._settings.get_boolean('dry-run')}};""")
    check('extension state is ACTIVE', state['state'] == 1, json.dumps(state))
    if not state['dry']:
        raise SystemExit('dry-run setting is not on; refusing to schedule anything')
    time.sleep(1)

    print('==> Idle menu')
    info = shell_eval(f"""{IND}
        ind.menu.open();
        return {{
            presets: ind._presetSection._getMenuItems().map(i => i.label.text),
            status: ind._statusItem._title.text,
            countdownVisible: ind._countdown.visible,
            activeVisible: ind._activeSection.actor.visible,
        }};""")
    check('presets are 10 / 30 / 60 minutes',
          info['presets'] == ['10 minutes', '30 minutes', '1 hour'], json.dumps(info['presets']))
    check('idle status says nothing is scheduled', info['status'] == 'No shutdown scheduled', info['status'])
    check('idle: no countdown, no cancel/postpone', not info['countdownVisible'] and not info['activeVisible'])
    time.sleep(0.5)
    screenshot('01-menu-idle')

    print('==> Preset: 10 minutes')
    start = now_us()
    shell_eval(f"{IND} ind._presetSection._getMenuItems()[0].activate(null); return true;")
    sched = wait_for(lambda: logind_schedule() if logind_schedule() != NOTHING else None, timeout=5)
    delta = (sched[1] - start) / 1e6 if sched else None
    check('logind has a poweroff scheduled ~600 s ahead', sched and sched[0] == 'poweroff' and 598 <= delta <= 603,
          f'{sched}, delta={delta}')
    time.sleep(1.5)
    info = shell_eval(f"""{IND}
        ind.menu.open();
        return {{label: ind._countdown.text, visible: ind._countdown.visible,
                status: ind._statusItem._title.text, sub: ind._statusItem._subtitle.text,
                activeVisible: ind._activeSection.actor.visible,
                postpone: ind._postponeItem.label.text}};""")
    check('panel countdown visible and near 10:00', info['visible'] and info['label'] in ('9:59', '9:58', '9:57', '10:00'),
          json.dumps(info))
    check('menu shows cancel and postpone', info['activeVisible'] and info['postpone'] == 'Postpone by 10 minutes')
    check('status subtitle shows 10 min remaining', info['sub'] == '10 min remaining', info['sub'])
    time.sleep(0.5)
    screenshot('02-menu-active', 'menu', (880, 0, 400, 440))

    print('==> Postpone')
    before = logind_schedule()[1]
    shell_eval(f"{IND} ind._postponeItem.activate(null); return true;")
    after = wait_for(lambda: logind_schedule()[1] if logind_schedule()[1] != before else None, timeout=5)
    check('postpone adds 10 minutes', after and abs((after - before) / 1e6 - 600) < 2, f'{(after - before) / 1e6 if after else None}s')

    print('==> Custom dialog: delay mode')
    info = shell_eval(f"""{IND}
        ind._openCustomDialog();
        const d = ind._dialog;
        return {{hours: d._hours.value, minutes: d._minutes.value, summary: d._summary.text,
                hoursText: d._hours.entry.text}};""")
    check('dialog opens with the last custom delay (1 h 30 min)', info['hours'] == 1 and info['minutes'] == 30, json.dumps(info))
    time.sleep(1)
    screenshot('03-dialog-delay')

    info = shell_eval(f"""{IND}
        const d = ind._dialog;
        const r = {{}};
        d._minutes.entry.text = '7x';
        r.typed = d._minutes.value; r.typedText = d._minutes.entry.text;
        d._minutes.entry.text = '75';
        r.clamped = d._minutes.value;
        d._minutes.setValue(55); d._minutes.stepBy(1);
        r.carry = [d._hours.value, d._minutes.value];
        d._hours.setValue(0); d._minutes.setValue(0);
        r.zeroReactive = d._scheduleButton.reactive; r.zeroSummary = d._summary.text;
        d._minutes.stepBy(-1);
        r.noUnderflow = [d._hours.value, d._minutes.value];
        d._hours.setValue(2); d._minutes.setValue(15);
        r.summary = d._summary.text; r.reactive = d._scheduleButton.reactive;
        return r;""")
    check('typing strips non-digits', info['typed'] == 7 and info['typedText'] == '7', json.dumps(info))
    check('minutes over 59 are clamped', info['clamped'] == 59)
    check('55 min + step carries into hours', info['carry'] == [2, 0], json.dumps(info['carry']))
    check('zero delay disables Schedule', info['zeroReactive'] is False, info['zeroSummary'])
    check('stepping below 0:00 is clamped', info['noUnderflow'] == [0, 0], json.dumps(info['noUnderflow']))
    check('summary describes 2 hours 15 minutes', info['summary'].startswith('Shuts down in 2 hours 15 minutes, at ')
          and info['reactive'], info['summary'])
    time.sleep(0.5)
    screenshot('04-dialog-delay-2h15', 'custom-delay', (380, 150, 520, 500))

    start = now_us()
    shell_eval(f"{IND} ind._dialog._confirm(); return true;")
    sched = wait_for(lambda: logind_schedule() if abs((logind_schedule()[1] - start) / 1e6 - 8100) < 5 else None, timeout=5)
    check('custom delay schedules 2 h 15 min ahead', bool(sched), str(logind_schedule()))
    remembered = shell_eval(f"{IND} return ind._settings.get_int('last-custom-minutes');")
    check('custom delay remembered for next time', remembered == 135, str(remembered))

    print('==> Custom dialog: clock mode')
    target = GLib.DateTime.new_now_local().add_minutes(-30)  # already passed today -> tomorrow
    info = shell_eval(f"""{IND}
        ind._openCustomDialog();
        const d = ind._dialog;
        d._clockButton.emit('clicked', 1);
        d._hours.setValue({target.get_hour()}); d._minutes.setValue({target.get_minute()});
        return {{summary: d._summary.text, hoursTitle: d._hours._title.text, max: d._hours._max,
                clockChecked: d._clockButton.checked, delayChecked: d._delayButton.checked}};""")
    check('clock mode switches fields to 0–23 hours', info['max'] == 23 and info['hoursTitle'] == 'Hour (0–23)'
          and info['clockChecked'] and not info['delayChecked'], json.dumps(info))
    check('a past time of day means tomorrow', 'tomorrow at' in info['summary'], info['summary'])
    time.sleep(0.5)
    screenshot('05-dialog-clock', 'custom-time', (380, 150, 520, 500))
    shell_eval(f"{IND} ind._dialog._confirm(); return true;")
    expected = GLib.DateTime.new_local(target.get_year(), target.get_month(), target.get_day_of_month(),
                                       target.get_hour(), target.get_minute(), 0).add_days(1).to_unix()
    sched = wait_for(lambda: logind_schedule() if logind_schedule()[1] // 1_000_000 == expected else None, timeout=5)
    check('clock time schedules tomorrow at that time', bool(sched), f'{logind_schedule()} vs {expected}')

    print('==> Warning notification')
    shell_eval(f"{IND} ind._schedule(GLib.get_real_time() + 303 * 1000000); return true;")
    notified = wait_for(lambda: shell_eval(f"{IND} return ind._warning ? ind._warning.title : null;"), timeout=10)
    check('5-minute warning notification shown', notified and notified.startswith('Shutting down in 5 min'), str(notified))
    actions = shell_eval(f"{IND} return ind._warning ? ind._warning.actions.map(a => a.label) : [];")
    check('warning offers Postpone and Cancel', actions == ['Postpone by 10 minutes', 'Cancel Shutdown'], json.dumps(actions))
    time.sleep(1)
    screenshot('06-warning', 'warning', (360, 0, 560, 160))

    print('==> Short timer skips warnings that already passed')
    shell_eval(f"{IND} ind._warning?.destroy(); ind._schedule(GLib.get_real_time() + 180 * 1000000); return true;")
    time.sleep(2.5)
    warn = shell_eval(f"{IND} return ind._warning ? ind._warning.title : null;")
    check('3-minute timer does not fire the 5-minute warning', warn is None, str(warn))

    print('==> External schedule (shutdown -r) is picked up')
    logind_dry_schedule('dry-reboot', now_us() + 3600 * 1_000_000)
    title = wait_for(lambda: shell_eval(f"{IND} return ind._type === 'reboot' ? ind._statusItem._title.text : null;"),
                     timeout=8)
    check('menu reflects a reboot scheduled outside the extension', title and title.startswith('Restart at'), str(title))

    print('==> Disable/enable keeps the logind schedule')
    logind_dry_schedule('dry-poweroff', now_us() + 1200 * 1_000_000)
    time.sleep(0.5)
    before = logind_schedule()
    shell_eval(f"Main.extensionManager.disableExtension('{UUID}'); return true;")
    time.sleep(1)
    gone = shell_eval(f"return !Main.panel.statusArea['{UUID}'];")
    still = logind_schedule()
    shell_eval(f"Main.extensionManager.enableExtension('{UUID}'); return true;")
    picked = wait_for(lambda: shell_eval(f"{IND} return ind && ind._deadline;"), timeout=8)
    check('disable removes the indicator', gone)
    check('disable does not cancel the shutdown', still == before, f'{before} -> {still}')
    check('re-enabled indicator shows the existing schedule', picked == before[1], f'{picked} vs {before[1]}')

    print('==> Cancel')
    shell_eval(f"{IND} ind.menu.open(); return true;")
    shell_eval(f"{IND} ind._activeSection._getMenuItems()[2].activate(null); return true;")
    cleared = wait_for(lambda: logind_schedule() == NOTHING, timeout=5)
    time.sleep(1.2)
    info = shell_eval(f"{IND} return {{visible: ind._countdown.visible, status: ind._statusItem._title.text}};")
    check('cancel clears the logind schedule', cleared, str(logind_schedule()))
    check('cancel hides the countdown', not info['visible'] and info['status'] == 'No shutdown scheduled', json.dumps(info))

    print('==> Preferences window')
    subprocess.run(['dbus-update-activation-environment', 'WAYLAND_DISPLAY=wayland-extension-test'], check=False)
    shell_eval(f"{IND} ind.menu.open(); ind.menu._getMenuItems().at(-1).activate(null); return true;")
    title = wait_for(lambda: shell_eval(
        "return global.get_window_actors().map(a => a.meta_window.get_title()).find(t => t?.includes('Auto Shutdown')) ?? null;"),
        timeout=15)
    check('Settings opens the preferences window', bool(title), str(title))
    time.sleep(1.5)
    screenshot('07-prefs', 'preferences', (300, 100, 680, 545))


if __name__ == '__main__':
    main()
