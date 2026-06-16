'use strict';

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SELECTED_TEAM_KEY = 'selected-team';
const SHOW_FLAGS_KEY = 'show-flags';
const AUTO_UPDATE_KEY = 'auto-update';
const SCHEDULE_URL_KEY = 'schedule-url';

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

async function loadTeams(extension) {
    const file = Gio.File.new_for_path(`${extension.path}/data/matches.json`);
    const schedule = JSON.parse(await readTextFile(file));
    return schedule.teams;
}

export default class WorldCupNextMatchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._fillPreferencesWindow(window).catch(error => {
            const page = new Adw.PreferencesPage({
                title: 'World Cup',
                icon_name: 'dialog-error-symbolic',
            });
            const group = new Adw.PreferencesGroup({
                title: 'Schedule could not be loaded',
                description: error.message,
            });
            page.add(group);
            window.add(page);
        });
    }

    async _fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const teams = await loadTeams(this);
        const teamNames = ['Choose a team', ...teams];
        const model = Gtk.StringList.new(teamNames);

        const page = new Adw.PreferencesPage({
            title: 'World Cup',
            icon_name: 'emblem-favorite-symbolic',
        });

        const teamGroup = new Adw.PreferencesGroup({
            title: 'Team',
            description: 'Select the team shown in the top bar.',
        });
        page.add(teamGroup);

        const row = new Adw.ComboRow({
            title: 'Selected team',
            subtitle: 'Bundled fixtures load offline; remote updates can add knockout matches.',
            model,
        });
        teamGroup.add(row);

        const selectedTeam = settings.get_string(SELECTED_TEAM_KEY);
        const selectedIndex = teams.indexOf(selectedTeam);
        row.selected = selectedIndex >= 0 ? selectedIndex + 1 : 0;

        row.connectObject(
            'notify::selected',
            () => {
                const selected = row.selected;
                settings.set_string(
                    SELECTED_TEAM_KEY,
                    selected > 0 ? teams[selected - 1] : '');
            },
            window);

        const flagsRow = new Adw.SwitchRow({
            title: 'Show flags',
            subtitle: 'Turn off if flag emoji do not render on your system.',
        });
        teamGroup.add(flagsRow);
        settings.bind(
            SHOW_FLAGS_KEY,
            flagsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        const scheduleGroup = new Adw.PreferencesGroup({
            title: 'Schedule updates',
            description: 'A cached JSON feed can add or override matches after the group stage.',
        });
        page.add(scheduleGroup);

        const autoUpdateRow = new Adw.SwitchRow({
            title: 'Update schedule automatically',
            subtitle: 'Checks at most once every six hours and falls back to bundled data.',
        });
        scheduleGroup.add(autoUpdateRow);
        settings.bind(
            AUTO_UPDATE_KEY,
            autoUpdateRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        const urlRow = new Adw.EntryRow({
            title: 'Schedule feed URL',
        });
        scheduleGroup.add(urlRow);
        settings.bind(
            SCHEDULE_URL_KEY,
            urlRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT);

        window.add(page);
    }
}
