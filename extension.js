'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const INDICATOR_NAME = 'world-cup-next-match';
const SELECTED_TEAM_KEY = 'selected-team';
const SHOW_FLAGS_KEY = 'show-flags';
const AUTO_UPDATE_KEY = 'auto-update';
const SCHEDULE_URL_KEY = 'schedule-url';
const LAST_UPDATE_CHECK_KEY = 'last-update-check';

const UPDATE_INTERVAL_SECONDS = 6 * 60 * 60;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// How long a match keeps showing as LIVE after kickoff. (since no API to pull when match is done)
const MATCH_DISPLAY_DURATION_MS = 2.5 * HOUR_MS;

const STAGE_LABELS = {
    group: 'Group stage',
    'round-of-32': 'Round of 32',
    'round-of-16': 'Round of 16',
    quarterfinals: 'Quarter-finals',
    semifinals: 'Semi-finals',
    'third-place': 'Third-place match',
    final: 'Final',
};

const TEAM_FLAG_CODES = {
    Algeria: 'DZ',
    Argentina: 'AR',
    Australia: 'AU',
    Austria: 'AT',
    Belgium: 'BE',
    'Bosnia and Herzegovina': 'BA',
    Brazil: 'BR',
    'Cabo Verde': 'CV',
    Canada: 'CA',
    Colombia: 'CO',
    "Cote d'Ivoire": 'CI',
    Croatia: 'HR',
    Curacao: 'CW',
    Czechia: 'CZ',
    'DR Congo': 'CD',
    Ecuador: 'EC',
    Egypt: 'EG',
    England: 'GB-ENG',
    France: 'FR',
    Germany: 'DE',
    Ghana: 'GH',
    Haiti: 'HT',
    Iran: 'IR',
    Iraq: 'IQ',
    Japan: 'JP',
    Jordan: 'JO',
    Mexico: 'MX',
    Morocco: 'MA',
    Netherlands: 'NL',
    'New Zealand': 'NZ',
    Norway: 'NO',
    Panama: 'PA',
    Paraguay: 'PY',
    Portugal: 'PT',
    Qatar: 'QA',
    'Saudi Arabia': 'SA',
    Scotland: 'GB-SCT',
    Senegal: 'SN',
    'South Africa': 'ZA',
    'South Korea': 'KR',
    Spain: 'ES',
    Sweden: 'SE',
    Switzerland: 'CH',
    Tunisia: 'TN',
    Turkiye: 'TR',
    'United States': 'US',
    Uruguay: 'UY',
    Uzbekistan: 'UZ',
};

function cachePath(extension) {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        extension.uuid,
        'schedule.json',
    ]);
}

async function readTextFile(file) {
    const contents = await new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [, bytes] = source.load_contents_finish(result);
                resolve(bytes);
            } catch (error) {
                reject(error);
            }
        });
    });

    return new TextDecoder().decode(contents);
}

async function writeTextFile(file, text) {
    const bytes = new GLib.Bytes(new TextEncoder().encode(text));

    await new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function normalizeSchedule(schedule) {
    if (!schedule || !Array.isArray(schedule.matches))
        throw new Error('Schedule must include a matches array');

    const matches = schedule.matches.map((match, index) => {
        if (!match.home || !match.away || !match.kickoffUtc)
            throw new Error(`Match ${index + 1} is missing home, away, or kickoffUtc`);

        const kickoffMs = Date.parse(match.kickoffUtc);
        if (!Number.isFinite(kickoffMs))
            throw new Error(`Match ${index + 1} has an invalid kickoffUtc`);

        return {
            id: match.id ?? `${match.kickoffUtc}:${match.home}:${match.away}`,
            stage: match.stage ?? (match.group ? 'group' : ''),
            group: match.group ?? '',
            home: match.home,
            away: match.away,
            kickoffUtc: match.kickoffUtc,
            kickoffMs,
            venue: match.venue ?? '',
        };
    });

    matches.sort((a, b) => a.kickoffMs - b.kickoffMs || `${a.id}`.localeCompare(`${b.id}`));

    const teams = Array.from(new Set([
        ...(Array.isArray(schedule.teams) ? schedule.teams : []),
        ...matches.flatMap(match => [match.home, match.away]),
    ])).sort();

    const eliminatedTeams = Array.from(new Set(
        Array.isArray(schedule.eliminatedTeams)
            ? schedule.eliminatedTeams.filter(team => typeof team === 'string')
            : []
    )).sort();

    return {
        eliminatedTeams,
        teams,
        matches,
    };
}

async function loadBundledSchedule(extension) {
    const file = extension.dir.get_child('data').get_child('matches.json');
    const text = await readTextFile(file);
    return normalizeSchedule(JSON.parse(text));
}

async function loadCachedSchedule(extension) {
    const file = Gio.File.new_for_path(cachePath(extension));
    try {
        const text = await readTextFile(file);
        return normalizeSchedule(JSON.parse(text));
    } catch (error) {
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;

        throw error;
    }
}

async function saveCachedSchedule(extension, schedule) {
    const path = cachePath(extension);
    const directory = GLib.path_get_dirname(path);
    GLib.mkdir_with_parents(directory, 0o700);
    await writeTextFile(Gio.File.new_for_path(path), JSON.stringify(schedule, null, 2));
}

function mergeSchedules(bundledSchedule, remoteSchedule) {
    if (!remoteSchedule)
        return bundledSchedule;

    const byId = new Map();
    bundledSchedule.matches.forEach(match => byId.set(`${match.id}`, match));
    remoteSchedule.matches.forEach(match => byId.set(`${match.id}`, match));

    return normalizeSchedule({
        eliminatedTeams: [
            ...bundledSchedule.eliminatedTeams,
            ...remoteSchedule.eliminatedTeams,
        ],
        teams: [...bundledSchedule.teams, ...remoteSchedule.teams],
        matches: Array.from(byId.values()),
    });
}

function regionalIndicatorFlag(countryCode) {
    return countryCode
        .toUpperCase()
        .split('')
        .map(letter => String.fromCodePoint(0x1F1E6 + letter.charCodeAt(0) - 65))
        .join('');
}

function subdivisionFlag(subdivisionCode) {
    const tag = subdivisionCode.toLowerCase().replace('-', '');
    const tagCharacters = tag
        .split('')
        .map(character => String.fromCodePoint(0xE0000 + character.charCodeAt(0)))
        .join('');

    return `\u{1F3F4}${tagCharacters}\u{E007F}`;
}

function flagForTeam(team) {
    const code = TEAM_FLAG_CODES[team];
    if (!code)
        return '';

    if (code.startsWith('GB-'))
        return subdivisionFlag(code);

    return regionalIndicatorFlag(code);
}

function formatTeam(team, showFlags, flagFirst = false) {
    const flag = showFlags ? flagForTeam(team) : '';
    if (!flag)
        return team;

    return flagFirst ? `${team} ${flag}` : `${flag} ${team}`;
}

function formatFixture(match, showFlags) {
    return formatTeam(match.home, showFlags, true) + " vs " + formatTeam(match.away, showFlags);
}

function isMatchLive(match, nowMs) {
    return nowMs >= match.kickoffMs &&
        nowMs < match.kickoffMs + MATCH_DISPLAY_DURATION_MS;
}

function formatMatchState(match, nowMs) {
    if (isMatchLive(match, nowMs))
        return 'LIVE';

    const msUntilKickoff = match.kickoffMs - nowMs;

    if (msUntilKickoff < HOUR_MS)
        return `in ${Math.max(1, Math.floor(msUntilKickoff / MINUTE_MS))}m`;

    if (msUntilKickoff < DAY_MS)
        return `in ${Math.floor(msUntilKickoff / HOUR_MS)}h`;

    return `in ${Math.floor(msUntilKickoff / DAY_MS)}d`;
}

function formatLocalKickoff(match) {
    const date = new Date(match.kickoffMs);
    return new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

function formatStage(match) {
    if (match.stage && match.stage !== 'group')
        return STAGE_LABELS[match.stage] ?? match.stage.replaceAll('-', ' ');

    if (match.group)
        return `Group ${match.group}`;

    return match.stage === 'group' ? STAGE_LABELS.group : 'World Cup';
}

function secondsUntilNextRefresh(match, nowMs) {
    if (!match)
        return 0;

    const msUntilKickoff = match.kickoffMs - nowMs;
    if (msUntilKickoff <= 0)
        return 30 * 60;

    const unitMs = msUntilKickoff < HOUR_MS ? MINUTE_MS
        : msUntilKickoff < DAY_MS ? HOUR_MS
        : DAY_MS;
    return Math.max(1, Math.ceil((msUntilKickoff % unitMs || unitMs) / 1000));
}

const NextMatchIndicator = GObject.registerClass(
class NextMatchIndicator extends PanelMenu.Button {
    _init(extension, schedule) {
        super._init(0.0, 'World Cup Next Match');

        this._extension = extension;
        this._schedule = schedule;
        this._settings = extension.getSettings();
        this._timeoutId = 0;
        this._updating = false;
        this._lastUpdateError = '';
        this._settings.connectObject(
            `changed::${SELECTED_TEAM_KEY}`,
            () => this._refresh(),
            `changed::${SHOW_FLAGS_KEY}`,
            () => this._refresh(),
            this);

        this._label = new St.Label({
            text: 'World Cup',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'max-width: 360px;',
        });
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this.add_child(this._label);

        this._refresh();
    }

    destroy() {
        this._clearTimeout();
        this._settings.disconnectObject(this);

        super.destroy();
    }

    setSchedule(schedule) {
        this._schedule = schedule;
        this._refresh();
    }

    setUpdateState(updating, error = '') {
        this._updating = updating;
        this._lastUpdateError = error;
        this._refresh();
    }

    _clearTimeout() {
        if (!this._timeoutId)
            return;

        GLib.Source.remove(this._timeoutId);
        this._timeoutId = 0;
    }

    _findVisibleMatch(team, nowMs) {
        if (!this._schedule || !team)
            return null;

        return this._schedule.matches.find(match => {
            if (match.home !== team && match.away !== team)
                return false;

            return match.kickoffMs + MATCH_DISPLAY_DURATION_MS > nowMs;
        }) ?? null;
    }

    _isTeamEliminated(team) {
        return Boolean(this._schedule?.eliminatedTeams.includes(team));
    }

    _refresh() {
        this._clearTimeout();

        const team = this._settings.get_string(SELECTED_TEAM_KEY);
        const showFlags = this._settings.get_boolean(SHOW_FLAGS_KEY);
        const nowMs = Date.now();
        const match = this._findVisibleMatch(team, nowMs);

        this.menu.removeAll();

        if (!this._schedule) {
            this._label.text = 'World Cup';
            this._addStatusItem('Loading schedule...');
        } else if (!team) {
            this._label.text = 'World Cup';
            this._addStatusItem('Choose a team in Preferences');
        } else if (this._isTeamEliminated(team)) {
            this._label.text = `${formatTeam(team, showFlags)} was eliminated`;
            this._addStatusItem('Team was eliminated');
        } else if (!match) {
            this._label.text = 'No scheduled match';
            this._addStatusItem(`No remaining scheduled match for ${team}`);
        } else {
            const matchState = formatMatchState(match, nowMs);
            this._label.text = `${formatFixture(match, showFlags)} ${matchState}`;
            this._addMatchItems(match, matchState, showFlags);

            const refreshSeconds = secondsUntilNextRefresh(match, nowMs);
            if (refreshSeconds > 0) {
                this._timeoutId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    refreshSeconds,
                    () => {
                        this._timeoutId = 0;
                        this._refresh();
                        return GLib.SOURCE_REMOVE;
                    });
            }
        }

        this._addScheduleStatus();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem =
            new PopupMenu.PopupImageMenuItem('Refresh schedule', 'view-refresh-symbolic');
        refreshItem.connectObject(
            'activate',
            () => this._extension.refreshSchedule(true),
            this);
        this.menu.addMenuItem(refreshItem);

        const preferencesItem =
            new PopupMenu.PopupImageMenuItem('Preferences', 'emblem-system-symbolic');
        preferencesItem.connectObject(
            'activate',
            () => this._extension.openPreferences(),
            this);
        this.menu.addMenuItem(preferencesItem);
    }

    _addStatusItem(text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        this.menu.addMenuItem(item);
    }

    _addMatchItems(match, matchState, showFlags) {
        this._addStatusItem(`${formatFixture(match, showFlags)} ${matchState}`);
        this._addStatusItem(formatStage(match));
        this._addStatusItem(formatLocalKickoff(match));

        if (match.venue)
            this._addStatusItem(match.venue);
    }

    _addScheduleStatus() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const statusText = this._updating
            ? 'Updating schedule...'
            : this._lastUpdateError || (this._schedule
                ? `Schedule: ${this._schedule.matches.length} matches`
                : 'Schedule not loaded');
        this._addStatusItem(statusText);
    }
});

export default class WorldCupNextMatchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._session = null;
        this._updateTimeoutId = 0;
        this._bundledSchedule = null;
        this._remoteSchedule = null;
        this._schedule = null;

        this._indicator = new NextMatchIndicator(this, this._schedule);
        Main.panel.addToStatusArea(INDICATOR_NAME, this._indicator);

        this._settings.connectObject(
            `changed::${AUTO_UPDATE_KEY}`,
            () => {
                this._scheduleUpdateTimer();

                if (this._settings.get_boolean(AUTO_UPDATE_KEY))
                    this.refreshSchedule(true);
            },
            `changed::${SCHEDULE_URL_KEY}`,
            () => {
                this.refreshSchedule(true);
                this._scheduleUpdateTimer();
            },
            this);

        this._loadSchedules();
    }

    disable() {
        this._clearUpdateTimer();

        this._session?.abort();
        this._session = null;

        this._settings.disconnectObject(this);

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._bundledSchedule = null;
        this._remoteSchedule = null;
        this._schedule = null;
    }

    async _loadSchedules() {
        try {
            this._bundledSchedule = await loadBundledSchedule(this);

            try {
                this._remoteSchedule = await loadCachedSchedule(this);
            } catch (error) {
                console.warn(`World Cup Next Match: ignoring invalid cached schedule: ${error.message}`);
            }

            if (!this._indicator)
                return;

            this._schedule = mergeSchedules(this._bundledSchedule, this._remoteSchedule);
            this._indicator.setSchedule(this._schedule);
            this.refreshSchedule(false);
            this._scheduleUpdateTimer();
        } catch (error) {
            console.error(`World Cup Next Match: failed to load bundled schedule: ${error.message}`);
            this._indicator?.setUpdateState(false, `Schedule load failed: ${error.message}`);
        }
    }

    _clearUpdateTimer() {
        if (!this._updateTimeoutId)
            return;

        GLib.Source.remove(this._updateTimeoutId);
        this._updateTimeoutId = 0;
    }

    _scheduleUpdateTimer() {
        this._clearUpdateTimer();

        if (!this._settings?.get_boolean(AUTO_UPDATE_KEY))
            return;

        if (!this._settings.get_string(SCHEDULE_URL_KEY).trim())
            return;

        const nowSeconds = Math.floor(Date.now() / 1000);
        const lastCheck = this._settings.get_int64(LAST_UPDATE_CHECK_KEY);
        const elapsedSeconds = Math.max(0, nowSeconds - lastCheck);
        const nextCheckSeconds = Math.max(
            60,
            UPDATE_INTERVAL_SECONDS - elapsedSeconds);

        this._updateTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            nextCheckSeconds,
            () => {
                this._updateTimeoutId = 0;
                this.refreshSchedule(false);
                this._scheduleUpdateTimer();
                return GLib.SOURCE_REMOVE;
            });
    }

    refreshSchedule(force = false) {
        if (!this._bundledSchedule)
            return;

        if (!this._settings.get_boolean(AUTO_UPDATE_KEY) && !force)
            return;

        const url = this._settings.get_string(SCHEDULE_URL_KEY).trim();
        if (!url)
            return;

        const nowSeconds = Math.floor(Date.now() / 1000);
        const lastCheck = this._settings.get_int64(LAST_UPDATE_CHECK_KEY);
        if (!force && nowSeconds - lastCheck < UPDATE_INTERVAL_SECONDS)
            return;

        this._settings.set_int64(LAST_UPDATE_CHECK_KEY, nowSeconds);
        this._indicator?.setUpdateState(true);

        this._session?.abort();
        this._session = new Soup.Session({timeout: 15});

        const message = Soup.Message.new('GET', url);
        if (!message) {
            this._indicator?.setUpdateState(false, 'Schedule update failed: invalid URL');
            return;
        }

        message.request_headers.append(
            'User-Agent',
            `${this.uuid}/1.0 GNOME Shell Extension`);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            async (session, result) => {
                if (!this._indicator)
                    return;

                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.status_code < 200 || message.status_code >= 300)
                        throw new Error(`HTTP ${message.status_code}`);

                    const text = new TextDecoder().decode(bytes.get_data());
                    const remoteSchedule = normalizeSchedule(JSON.parse(text));
                    await saveCachedSchedule(this, remoteSchedule);

                    this._remoteSchedule = remoteSchedule;
                    this._schedule = mergeSchedules(this._bundledSchedule, this._remoteSchedule);
                    this._indicator?.setSchedule(this._schedule);
                    this._indicator?.setUpdateState(false);
                } catch (error) {
                    this._indicator?.setUpdateState(
                        false,
                        `Schedule update failed: ${error.message}`);
                }
            });
    }
}
