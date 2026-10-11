import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSampleCsv, parseWallClock, unionSamples, samplesToDays, samplesFragment, rowsRange } from '../src/lib/healthsync.js';

// Synthetic files in the layout Health Sync writes to Google Drive.
const csv = (header, rows) => [header, ...rows].join('\n') + '\n';

test('wall-clock dates in Health Sync formats', () => {
  assert.deepEqual(parseWallClock('2026.03.07 08:05:00', '08:05:00'), { day: '2026-03-07', sec: 8 * 3600 + 5 * 60 });
  assert.deepEqual(parseWallClock('2026-03-07', '23:59'), { day: '2026-03-07', sec: 86340 });
  assert.deepEqual(parseWallClock('07/03/2026 6:30'), { day: '2026-03-07', sec: 6 * 3600 + 1800 });
  assert.deepEqual(parseWallClock('2026.03.07'), { day: '2026-03-07', sec: null });
  assert.equal(parseWallClock('2026.02.30 10:00:00'), null);
  assert.equal(parseWallClock('2026.03.07 24:00:00'), null);
  assert.equal(parseWallClock('yesterday'), null);
});

test('per-minute CSVs are recognised by their value column', () => {
  const steps = parseSampleCsv(csv('Data,Orario,Passi', ['2026.03.07 08:00:00,08:00:00,40', '2026.03.07 08:01:00,08:01:00,75']));
  assert.equal(steps.metric, 'steps');
  assert.equal(steps.rows.length, 2);
  const hr = parseSampleCsv(csv('Data,Orario,Frequenza cardiaca,Origine', ['2026.03.07 08:00:00,08:00:00,61,', '2026.03.07 08:10:00,08:10:00,64,']));
  assert.equal(hr.metric, 'hr');
  assert.deepEqual(hr.rows[1], { day: '2026-03-07', sec: 8 * 3600 + 600, v: 64 });
  const spo2 = parseSampleCsv(csv('Data,Orario,Saturazione di ossigeno', ['2026.03.07 03:00:00,03:00:00,97.0']));
  assert.equal(spo2.metric, 'spo2');
  assert.equal(spo2.rows[0].v, 97);
  const en = parseSampleCsv(csv('Date,Time,Heart rate (bpm)', ['2026-03-07,08:00,70']));
  assert.equal(en.metric, 'hr');
  assert.equal(en.rows[0].sec, 8 * 3600);
  const semicolons = parseSampleCsv('﻿Data;Orario;Passi\r\n07.03.2026 08:00:00;08:00:00;12\r\n');
  assert.deepEqual(semicolons.rows, [{ day: '2026-03-07', sec: 8 * 3600, v: 12 }]);
  // header only
  assert.deepEqual(parseSampleCsv('Data,Orario,Passi\n'), { metric: 'steps', header: ['Data', 'Orario', 'Passi'], rows: [] });
  // unknown value column → not recognised
  assert.equal(parseSampleCsv(csv('Data,Orario,Valore sconosciuto', ['2026.03.07 01:00:00,01:00:00,3'])).metric, null);
  // dates without a time of day are a daily summary, not samples
  assert.equal(parseSampleCsv(csv('Date,Steps', ['2026-03-07,8000'])).metric, null);
});

test('steps, heart rate and SpO2 aggregate like the export parsers', () => {
  const steps = parseSampleCsv(csv('Data,Orario,Passi', [
    '2026.03.07 08:00:00,08:00:00,40',
    '2026.03.07 08:01:00,08:01:00,75',
    '2026.03.07 13:30:00,13:30:00,100',
    '2026.03.08 00:10:00,00:10:00,12',
  ]));
  const days = samplesToDays('steps', unionSamples([{ m: 1, rows: steps.rows }]));
  assert.equal(days['2026-03-07'].steps, 215);
  assert.equal(days['2026-03-07'].activeMin, 2);
  assert.equal(days['2026-03-07'].stepsHourly[8], 115);
  assert.equal(days['2026-03-07'].stepsHourly[13], 100);
  assert.equal(days['2026-03-07'].stepsHourly.length, 24);
  assert.equal(days['2026-03-08'].steps, 12);

  const hr = parseSampleCsv(csv('Data,Orario,Frequenza cardiaca,Origine', [
    '2026.03.07 08:00:00,08:00:00,60,',
    '2026.03.07 08:30:00,08:30:00,80,',
    '2026.03.07 09:00:00,09:00:00,250,',
    '2026.03.07 22:00:00,22:00:00,55,',
  ]));
  const h = samplesToDays('hr', unionSamples([{ m: 1, rows: hr.rows }]))['2026-03-07'];
  assert.deepEqual([h.hrMin, h.hrMax, h.hrAvg, h.hrN], [55, 80, 65, 3]);
  assert.equal(h.hrHourly[8], 70);
  assert.equal(h.hrHourly[9], null);
  assert.equal(h.hrHourly[22], 55);

  const sp = parseSampleCsv(csv('Data,Orario,Saturazione di ossigeno', [
    '2026.03.07 02:00:00,02:00:00,96.0',
    '2026.03.07 03:00:00,03:00:00,99.0',
    '2026.03.07 04:00:00,04:00:00,40',
  ]));
  assert.deepEqual(samplesToDays('spo2', unionSamples([{ m: 1, rows: sp.rows }]))['2026-03-07'], { spo2Avg: 97.5, spo2Min: 96 });
});

test('daily and weekly files covering the same minutes are counted once', () => {
  const weekly = parseSampleCsv(csv('Data,Orario,Passi', ['2026.03.01 20:00:00,20:00:00,30', '2026.03.07 08:00:00,08:00:00,40']));
  const daily = parseSampleCsv(csv('Data,Orario,Passi', ['2026.03.07 08:00:00,08:00:00,40', '2026.03.07 08:01:00,08:01:00,10']));
  const hr = parseSampleCsv(csv('Data,Orario,Frequenza cardiaca,Origine', ['2026.03.07 08:00:00,08:00:00,70,']));
  const days = samplesFragment([
    { metric: 'steps', rows: weekly.rows, m: 100 },
    { metric: 'steps', rows: daily.rows, m: 200 },
    { metric: 'hr', rows: hr.rows, m: 150 },
  ]);
  assert.equal(days['2026-03-07'].steps, 50);
  assert.equal(days['2026-03-07'].hrAvg, 70);
  assert.equal(days['2026-03-01'].steps, 30);

  // the newer file wins a disputed minute
  const fixed = parseSampleCsv(csv('Data,Orario,Passi', ['2026.03.07 08:00:00,08:00:00,44']));
  const again = samplesFragment([{ metric: 'steps', rows: fixed.rows, m: 300 }, { metric: 'steps', rows: daily.rows, m: 200 }]);
  assert.equal(again['2026-03-07'].steps, 54);

  // onlyDays limits the work
  const only = samplesFragment([{ metric: 'steps', rows: weekly.rows, m: 1 }], new Map([['steps', new Set(['2026-03-01'])]]));
  assert.deepEqual(Object.keys(only), ['2026-03-01']);
  assert.deepEqual(rowsRange(weekly.rows), ['2026-03-01', '2026-03-07']);
  assert.deepEqual(rowsRange([]), [null, null]);
});
