'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
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

// How long a match keeps showing as LIVE after kickoff. Knockout matches can
// run into extra time and penalties, so they get a longer window.
const GROUP_DISPLAY_DURATION_MS = 2 * HOUR_MS;
const KNOCKOUT_DISPLAY_DURATION_MS = 2.5 * HOUR_MS;

const STAGE_LABELS = {
    group: 'Group stage',
    'round-of-32': 'Round of 32',
    'round-of-16': 'Round of 16',
    quarterfinal: 'Quarter-final',
    quarterfinals: 'Quarter-finals',
    semifinal: 'Semi-final',
    semifinals: 'Semi-finals',
    'third-place': 'Third-place match',
    final: 'Final',
};

const COMPLETE_STAGE_MATCH_COUNTS = {
    'round-of-32': 16,
    'round-of-16': 8,
    quarterfinals: 4,
    semifinals: 2,
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
    const [contents] = await file.load_contents_async(null);
    return new TextDecoder().decode(contents);
}

async function writeTextFile(file, text) {
    const bytes = new GLib.Bytes(new TextEncoder().encode(text));
    await file.replace_contents_bytes_async(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null);
}

function normalizeSchedule(schedule, sourceLabel) {
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
            kickoff: match.kickoff ?? match.kickoffUtc,
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
        source: schedule.source ?? sourceLabel,
        updatedAt: schedule.updatedAt ?? '',
        eliminatedTeams,
        teams,
        matches,
    };
}

async function loadBundledSchedule(extension) {
    const file = extension.dir.get_child('data').get_child('matches.json');
    const text = await readTextFile(file);
    return normalizeSchedule(JSON.parse(text), 'bundled schedule');
}

async function loadCachedSchedule(extension) {
    const file = Gio.File.new_for_path(cachePath(extension));
    try {
        const text = await readTextFile(file);
        return normalizeSchedule(JSON.parse(text), 'cached remote schedule');
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
        source: remoteSchedule.source || bundledSchedule.source,
        updatedAt: remoteSchedule.updatedAt,
        eliminatedTeams: [
            ...bundledSchedule.eliminatedTeams,
            ...remoteSchedule.eliminatedTeams,
        ],
        teams: [...bundledSchedule.teams, ...remoteSchedule.teams],
        matches: Array.from(byId.values()),
    }, 'merged schedule');
}

function canonicalStage(stage) {
    if (stage === 'quarterfinal')
        return 'quarterfinals';

    if (stage === 'semifinal')
        return 'semifinals';

    return stage || '';
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

function isKnockoutMatch(match) {
    return Boolean(match.stage) && match.stage !== 'group';
}

function matchDisplayDuration(match) {
    return isKnockoutMatch(match)
        ? KNOCKOUT_DISPLAY_DURATION_MS
        : GROUP_DISPLAY_DURATION_MS;
}

function formatTeam(team, showFlags) {
    const flag = showFlags ? flagForTeam(team) : '';
    return flag ? `${team} ${flag}` : team;
}

function formatFixture(match, showFlags) {
    return `${formatTeam(match.home, showFlags)} vs ${formatTeam(match.away, showFlags)}`;
}

function isMatchLive(match, nowMs) {
    return nowMs >= match.kickoffMs &&
        nowMs < match.kickoffMs + matchDisplayDuration(match);
}

function formatMatchState(match, nowMs) {
    if (isMatchLive(match, nowMs))
        return 'LIVE';

    const msUntilKickoff = match.kickoffMs - nowMs;

    if (msUntilKickoff >= HOUR_MS) {
        const totalHours = Math.max(1, Math.floor(msUntilKickoff / HOUR_MS));
        const days = Math.floor(totalHours / 24);
        const hours = totalHours % 24;

        if (days > 0)
            return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;

        return `in ${totalHours}h`;
    }

    const minutes = Math.max(1, Math.ceil(msUntilKickoff / MINUTE_MS));
    return `in ${minutes}m`;
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

    return STAGE_LABELS[match.stage] ?? 'World Cup';
}

function secondsUntilNextRefresh(match, nowMs) {
    if (!match)
        return 0;

    const msUntilKickoff = match.kickoffMs - nowMs;

    if (msUntilKickoff <= 0) {
        const msUntilCurrentDisplayExpires =
            match.kickoffMs + matchDisplayDuration(match) - nowMs;
        return Math.max(60, Math.ceil(msUntilCurrentDisplayExpires / 1000));
    }

    if (msUntilKickoff > HOUR_MS) {
        const msUntilHourBoundary = msUntilKickoff % HOUR_MS || HOUR_MS;
        return Math.max(60, Math.ceil(Math.min(msUntilHourBoundary, msUntilKickoff) / 1000));
    }

    const msUntilMinuteBoundary = MINUTE_MS - (nowMs % MINUTE_MS);
    return Math.max(1, Math.ceil(Math.min(msUntilMinuteBoundary, msUntilKickoff) / 1000));
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
        this._settingsChangedIds = [
            this._settings.connect(
                `changed::${SELECTED_TEAM_KEY}`,
                () => this._refresh()),
            this._settings.connect(
                `changed::${SHOW_FLAGS_KEY}`,
                () => this._refresh()),
        ];

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

        this._settingsChangedIds.forEach(id => this._settings.disconnect(id));
        this._settingsChangedIds = [];

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
        if (!this._schedule)
            return null;

        if (!team)
            return null;

        return this._schedule.matches.find(match => {
            if (match.home !== team && match.away !== team)
                return false;

            return match.kickoffMs + matchDisplayDuration(match) > nowMs;
        }) ?? null;
    }

    _isTeamEliminated(team, nowMs) {
        if (!this._schedule)
            return false;

        if (this._schedule.eliminatedTeams.includes(team))
            return true;

        const teamMatches = this._schedule.matches.filter(match =>
            match.home === team || match.away === team);
        if (!teamMatches.length)
            return false;

        const lastTeamMatch = teamMatches[teamMatches.length - 1];
        if (nowMs < lastTeamMatch.kickoffMs + matchDisplayDuration(lastTeamMatch))
            return false;

        const nextMatch = teamMatches.find(match =>
            match.kickoffMs + matchDisplayDuration(match) > nowMs);
        if (nextMatch)
            return false;

        return this._hasCompleteLaterStageWithoutTeam(team, lastTeamMatch);
    }

    _hasCompleteLaterStageWithoutTeam(team, lastTeamMatch) {
        const lastStage = canonicalStage(lastTeamMatch.stage);

        if (lastStage === 'final' || lastStage === 'third-place')
            return false;

        if (lastStage === 'semifinals')
            return this._areFinalFixturesCompleteWithoutTeam(team);

        const nextStage = {
            group: 'round-of-32',
            'round-of-32': 'round-of-16',
            'round-of-16': 'quarterfinals',
            quarterfinals: 'semifinals',
        }[lastStage];

        if (!nextStage)
            return false;

        const nextStageMatches = this._schedule.matches.filter(match =>
            canonicalStage(match.stage) === nextStage);

        if (nextStageMatches.length < COMPLETE_STAGE_MATCH_COUNTS[nextStage])
            return false;

        return !nextStageMatches.some(match => match.home === team || match.away === team);
    }

    _areFinalFixturesCompleteWithoutTeam(team) {
        const finalStageMatches = this._schedule.matches.filter(match =>
            ['final', 'third-place'].includes(canonicalStage(match.stage)));

        if (finalStageMatches.length < 2)
            return false;

        return !finalStageMatches.some(match => match.home === team || match.away === team);
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
        } else if (this._isTeamEliminated(team, nowMs)) {
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
        refreshItem.connect('activate', () => this._extension.refreshSchedule(true));
        this.menu.addMenuItem(refreshItem);

        const preferencesItem =
            new PopupMenu.PopupImageMenuItem('Preferences', 'emblem-system-symbolic');
        preferencesItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(preferencesItem);
    }

    _addStatusItem(text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        this.menu.addMenuItem(item);
    }

    _addMatchItems(match, matchState, showFlags) {
        const title = new PopupMenu.PopupMenuItem(`${formatFixture(match, showFlags)} ${matchState}`);
        title.setSensitive(false);
        this.menu.addMenuItem(title);

        const stage = new PopupMenu.PopupMenuItem(formatStage(match));
        stage.setSensitive(false);
        this.menu.addMenuItem(stage);

        const kickoff = new PopupMenu.PopupMenuItem(formatLocalKickoff(match));
        kickoff.setSensitive(false);
        this.menu.addMenuItem(kickoff);

        if (match.venue) {
            const venue = new PopupMenu.PopupMenuItem(match.venue);
            venue.setSensitive(false);
            this.menu.addMenuItem(venue);
        }
    }

    _addScheduleStatus() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const statusText = this._updating
            ? 'Updating schedule...'
            : this._lastUpdateError || (this._schedule
                ? `Schedule: ${this._schedule.matches.length} matches`
                : 'Schedule not loaded');
        const status = new PopupMenu.PopupMenuItem(statusText);
        status.setSensitive(false);
        this.menu.addMenuItem(status);
    }
});

export default class WorldCupNextMatchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._session = null;
        this._updateTimeoutId = 0;
        this._settingsChangedIds = [];
        this._bundledSchedule = null;
        this._remoteSchedule = null;
        this._schedule = null;

        this._indicator = new NextMatchIndicator(this, this._schedule);
        Main.panel.addToStatusArea(INDICATOR_NAME, this._indicator);

        this._settingsChangedIds.push(this._settings.connect(
            `changed::${AUTO_UPDATE_KEY}`,
            () => {
                this._scheduleUpdateTimer();

                if (this._settings.get_boolean(AUTO_UPDATE_KEY))
                    this.refreshSchedule(true);
            }));
        this._settingsChangedIds.push(this._settings.connect(
            `changed::${SCHEDULE_URL_KEY}`,
            () => {
                this.refreshSchedule(true);
                this._scheduleUpdateTimer();
            }));

        this._loadSchedules();
    }

    disable() {
        this._clearUpdateTimer();

        this._session?.abort();
        this._session = null;

        this._settingsChangedIds.forEach(id => this._settings.disconnect(id));
        this._settingsChangedIds = [];

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
                    const remoteSchedule = normalizeSchedule(JSON.parse(text), 'remote schedule');
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
