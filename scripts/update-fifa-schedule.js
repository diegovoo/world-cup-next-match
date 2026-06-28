#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const API_BASE = 'https://api.fifa.com/api/v3';
const DEFAULT_OUTPUT_PATH = path.join(__dirname, '..', 'data', 'matches.json');
const COMPETITION_ID = '17';
const SEASON_ID = '285023';
const GROUP_STAGE_ID = '289273';
const MATCH_DISPLAY_DURATION_MS = 2.5 * 60 * 60 * 1000;

const TEAM_NAME_OVERRIDES = {
    "C\u00f4te d'Ivoire": "Cote d'Ivoire",
    'Congo DR': 'DR Congo',
    'Cura\u00e7ao': 'Curacao',
    'IR Iran': 'Iran',
    'Korea Republic': 'South Korea',
    'T\u00fcrkiye': 'Turkiye',
    USA: 'United States',
};

const STAGE_BY_FIFA_NAME = {
    'First Stage': 'group',
    Final: 'final',
    'Play-off for third place': 'third-place',
    'Quarter-final': 'quarterfinals',
    'Quarter-finals': 'quarterfinals',
    'Round of 16': 'round-of-16',
    'Round of 32': 'round-of-32',
    'Semi-final': 'semifinals',
    'Semi-finals': 'semifinals',
};

function localizedText(value) {
    if (!Array.isArray(value)) return '';

    return value.find(entry => entry.Locale?.startsWith('en'))?.Description ??
        value[0]?.Description ??
        '';
}

function normalizeTeamName(name) {
    return TEAM_NAME_OVERRIDES[name] ?? name;
}

function fifaTeamName(team) {
    if (!team?.IdTeam) return '';

    return normalizeTeamName(
        localizedText(team.TeamName) ||
        team.ShortClubName ||
        team.Abbreviation ||
        ''
    );
}

function matchId(match) {
    const number = Number(match.MatchNumber);
    return Number.isFinite(number) ? number : match.IdMatch;
}

function matchVenue(stadium, venueByStadiumId) {
    if (!stadium) return '';

    if (stadium.IdStadium && venueByStadiumId.has(stadium.IdStadium)) {
        return venueByStadiumId.get(stadium.IdStadium);
    }

    return [localizedText(stadium.Name), localizedText(stadium.CityName)]
        .filter(Boolean)
        .join(', ');
}

async function fetchJson(endpoint, params, continuation) {
    const url = new URL(`${API_BASE}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const headers = {
        Accept: 'application/json',
        'User-Agent': 'world-cup-next-match schedule updater',
    };

    if (continuation) {
        url.searchParams.set('continuationhash', continuation.hash);
        headers['x-mdp-continuation-token'] = continuation.token;
    }

    const response = await fetch(url, {headers});
    if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);

    return response.json();
}

async function fetchResults(endpoint, params) {
    const results = [];
    const seenHashes = new Set();
    let continuation = null;

    while (true) {
        const page = await fetchJson(endpoint, params, continuation);
        if (!Array.isArray(page.Results)) {
            throw new Error(`${endpoint} did not return a Results array`);
        }

        results.push(...page.Results);

        const hash = page.ContinuationHash;
        const token = page.ContinuationToken;
        if (!hash || !token || seenHashes.has(hash) || page.Results.length === 0) {
            return results;
        }

        seenHashes.add(hash);
        continuation = {hash, token};
    }
}

async function readExistingSchedule(outputPath) {
    try {
        return JSON.parse(await fs.readFile(outputPath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

function buildVenueMap(fifaMatches, existingSchedule) {
    const oldVenueByMatchId = new Map(
        (existingSchedule.matches ?? [])
            .filter(match => match.id && match.venue)
            .map(match => [String(match.id), match.venue])
    );

    const venueByStadiumId = new Map();
    for (const match of fifaMatches) {
        const stadiumId = match.Stadium?.IdStadium;
        const oldVenue = oldVenueByMatchId.get(String(matchId(match)));
        if (stadiumId && oldVenue && !venueByStadiumId.has(stadiumId)) {
            venueByStadiumId.set(stadiumId, oldVenue);
        }
    }

    return venueByStadiumId;
}

function convertMatch(match, venueByStadiumId) {
    const home = fifaTeamName(match.Home);
    const away = fifaTeamName(match.Away);
    if (!home || !away) return null;

    if (!Number.isFinite(Date.parse(match.Date))) {
        throw new Error(`Match ${match.IdMatch} has invalid Date: ${match.Date}`);
    }

    const stage = STAGE_BY_FIFA_NAME[localizedText(match.StageName)] ?? '';
    const group = localizedText(match.GroupName).match(/^Group\s+(.+)$/)?.[1] ?? '';
    const output = {
        id: matchId(match),
        home,
        away,
        kickoffUtc: match.Date,
        venue: matchVenue(match.Stadium, venueByStadiumId),
    };

    if (stage && stage !== 'group') output.stage = stage;
    if (group) output.group = group;

    return output;
}

function eliminatedTeamsFromStandings(standings, matches) {
    const nowMs = Date.now();
    const teamsWithVisibleMatches = new Set(
        matches
            .filter(match => Date.parse(match.kickoffUtc) + MATCH_DISPLAY_DURATION_MS > nowMs)
            .flatMap(match => [match.home, match.away])
    );

    return Array.from(new Set(
        standings
            .filter(row => row.QualificationStatus === 'Eliminated')
            .map(row => normalizeTeamName(localizedText(row.Team?.Name)))
            .filter(team => team && !teamsWithVisibleMatches.has(team))
    )).sort();
}

function validateSchedule(schedule) {
    const ids = new Set();

    for (const [index, match] of schedule.matches.entries()) {
        if (!match.home || !match.away || !match.kickoffUtc) {
            throw new Error(`Match ${index + 1} is missing home, away, or kickoffUtc`);
        }

        if (!Number.isFinite(Date.parse(match.kickoffUtc))) {
            throw new Error(`Match ${index + 1} has invalid kickoffUtc: ${match.kickoffUtc}`);
        }

        const id = String(match.id);
        if (ids.has(id)) throw new Error(`Duplicate match id: ${id}`);
        ids.add(id);
    }
}

async function main() {
    const outputPath = DEFAULT_OUTPUT_PATH;
    const existingSchedule = await readExistingSchedule(outputPath);
    const commonParams = {language: 'en', count: '500'};

    const [fifaMatches, fifaTeams, standings] = await Promise.all([
        fetchResults('/calendar/matches', {
            idCompetition: COMPETITION_ID,
            idSeason: SEASON_ID,
            ...commonParams,
        }),
        fetchResults(`/competitions/teams/${SEASON_ID}`, commonParams),
        fetchResults(
            `/calendar/${COMPETITION_ID}/${SEASON_ID}/${GROUP_STAGE_ID}/standing`,
            commonParams
        ),
    ]);

    const venueByStadiumId = buildVenueMap(fifaMatches, existingSchedule);
    const matches = fifaMatches
        .map(match => convertMatch(match, venueByStadiumId))
        .filter(Boolean)
        .sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc) ||
            String(a.id).localeCompare(String(b.id)));

    const teams = Array.from(new Set([
        ...fifaTeams.map(team => normalizeTeamName(localizedText(team.Name))),
        ...matches.flatMap(match => [match.home, match.away]),
    ].filter(Boolean))).sort();

    const schedule = {
        source: `FIFA public API, fetched ${new Date().toISOString()}`,
        eliminatedTeams: eliminatedTeamsFromStandings(standings, matches),
        teams,
        matches,
    };

    validateSchedule(schedule);
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    await fs.writeFile(outputPath, `${JSON.stringify(schedule, null, 2)}\n`);

    const skippedMatches = fifaMatches.length - matches.length;
    console.log(`Wrote ${matches.length} matches to ${path.relative(process.cwd(), outputPath)}`);
    console.log(`Marked ${schedule.eliminatedTeams.length} eliminated teams with no future fixture`);
    if (skippedMatches > 0) {
        console.log(`Skipped ${skippedMatches} unresolved placeholder matches`);
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
