import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_SCHEDULER_PRESETS,
  DataStore,
  applySyncTimingToPlanItems,
  buildAttackPlanMatrix,
  buildManualAttackPlanItem,
  calculateAutoDodgeTiming,
  calculateDistance,
  calculateSendTimeMs,
  classifyIncomingAttackUnit,
  computeHumanizedDelayMs,
  computeNextDailyScheduleMs,
  createDefaultAutoFarmConfig,
  decodeTwText,
  detectSlowestUnitFromTroops,
  detectSnipWindows,
  evaluateFarmSafetyStop,
  filterPlunderTargets,
  filterPlunderTargetsForPhase,
  findDuplicateFarmTargets,
  findNearestFriendlyVillage,
  findViableSnipSupports,
  formatProxyRules,
  generateFingerprint,
  getEffectiveTemplateOrder,
  parsePhpSerializedServers,
  parseWorldConfigXml,
  parseWorldPlayersTxt,
  parseWorldVillagesTxt,
  searchTargetPlayerVillages,
  selectDuePlayerFarmTargets,
} = require('../dist-electron/store.js');
const { SchedulerService } = require('../dist-electron/schedulerService.js');

test('DataStore CRUD for Tribal Wars accounts and proxies', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-store-test-'));
  try {
    const store = new DataStore(tmpDir);
    assert.equal(store.getAccounts().length, 0);

    const created = store.createAccount({
      username: 'PaladinBR',
      domain: 'tribalwars.com.br',
      world: 'br130',
      group: 'Front Sul',
      proxy: {
        enabled: true,
        protocol: 'socks5',
        host: '127.0.0.1',
        port: 1080,
      },
    });

    assert.equal(created.username, 'PaladinBR');
    assert.equal(created.serverUrl, 'https://br130.tribalwars.com.br');
    assert.equal(created.status, 'offline');
    assert.ok(created.fingerprint?.userAgent);

    const updated = store.updateAccount(created._id, {
      world: 'br131',
      playerInfo: { points: 12450, villagesCount: 3, incomings: 2 },
    });
    assert.equal(updated.world, 'br131');
    assert.equal(updated.serverUrl, 'https://br131.tribalwars.com.br');
    assert.equal(updated.playerInfo.points, 12450);

    const reloaded = new DataStore(tmpDir);
    assert.equal(reloaded.getAccounts().length, 1);
    assert.equal(reloaded.getAccounts()[0].username, 'PaladinBR');
    assert.equal(reloaded.getAccounts()[0].world, 'br131');

    const savedProxy = reloaded.saveProxy({
      enabled: true,
      protocol: 'http',
      host: '10.0.0.5',
      port: 8080,
      label: 'Proxy Dedicado #1',
    });
    assert.ok(savedProxy.id);
    assert.equal(reloaded.getProxies().length, 1);

    assert.equal(reloaded.deleteProxy(savedProxy.id), true);
    assert.equal(reloaded.getProxies().length, 0);

    assert.equal(reloaded.deleteAccount(created._id), true);
    assert.equal(reloaded.getAccounts().length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatProxyRules and parsePhpSerializedServers', () => {
  assert.equal(formatProxyRules(undefined), null);
  assert.equal(
    formatProxyRules({ enabled: false, protocol: 'http', host: '1.2.3.4', port: 8080 }),
    null
  );
  assert.equal(
    formatProxyRules({ enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 9050 }),
    'socks5://127.0.0.1:9050'
  );

  const samplePhp =
    'a:2:{s:5:"br129";s:32:"https://br129.tribalwars.com.br";s:5:"br130";s:32:"https://br130.tribalwars.com.br";}';
  const parsed = parsePhpSerializedServers(samplePhp);
  assert.deepEqual(parsed, {
    br129: 'https://br129.tribalwars.com.br',
    br130: 'https://br130.tribalwars.com.br',
  });

  const fp = generateFingerprint();
  assert.equal(fp.locale, 'pt-BR');
  assert.ok(fp.userAgent.includes('Mozilla/5.0'));
});

test('Wave 2: Scheduler math, Incoming Tagger unit classification, and Models CRUD', () => {
  // 3-4-5 right triangle: (500|500) -> (503|504) = 5 fields
  const dist = calculateDistance('500|500', '503|504');
  assert.equal(dist, 5);

  // Ram = 30 min/field -> 5 fields = 150 min = 9,000,000 ms
  const arrivalMs = 1_800_000_000_000;
  const calc = calculateSendTimeMs(arrivalMs, '500|500', '503|504', 'ram', 1, 1);
  assert.equal(calc.distance, 5);
  assert.equal(calc.travelTimeMs, 150 * 60 * 1000);
  assert.equal(calc.sendTimeMs, arrivalMs - 150 * 60 * 1000);

  // Incoming Tagger unit classification: 10 fields * 35 min/field = 350 min = 21000 sec -> Snob
  assert.equal(classifyIncomingAttackUnit(10, 21000, 1, 1), 'Nobre (Snob)');
  // 10 fields * 30 min/field = 300 min = 18000 sec -> Ram/Catapult
  assert.equal(classifyIncomingAttackUnit(10, 18000, 1, 1), 'Aríete / Catapulta');
  // 10 fields * 9 min/field = 90 min = 5400 sec -> Spy
  assert.equal(classifyIncomingAttackUnit(10, 5400, 1, 1), 'Explorador (Spy)');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wave2-test-'));
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({ username: 'Commander', world: 'br130' });

    // Feature 1: Scheduled Command creation & persistence
    const cmd = store.createScheduledCommand({
      accountId: acc._id,
      accountName: acc.username,
      originCoords: '500|500',
      targetCoords: '503|504',
      commandType: 'noble4',
      slowestUnit: 'snob',
      troops: { axe: 250, snob: 1 },
      waves: 4,
      arrivalTimeMs: arrivalMs,
      triggerBeforeMs: 30000,
    });
    assert.equal(cmd.distance, 5);
    assert.equal(cmd.travelTimeMs, 5 * 35 * 60 * 1000);
    assert.equal(store.getScheduledCommands(acc._id).length, 1);

    // Feature 2: Villages sync storage
    store.setAccountVillages(acc._id, [
      {
        id: 'v1',
        name: '001 | Capital',
        coords: '500|500',
        x: 500,
        y: 500,
        points: 9500,
        wood: 50000,
        stone: 40000,
        iron: 30000,
        storage: 400000,
        pop: 22000,
        popMax: 24000,
        updatedAt: new Date().toISOString(),
      },
    ]);
    assert.equal(store.getAccountById(acc._id)?.villages?.length, 1);

    // Feature 4: Construction & Recruitment Models defaults + custom
    assert.ok(store.getConstructionModels().length >= 3);
    assert.ok(store.getRecruitmentModels().length >= 4);

    const customConst = store.saveConstructionModel({
      name: 'Custom Rush Muralha',
      description: 'Muralha 20 rápida',
      steps: [{ building: 'wall', level: 20 }],
    });
    assert.ok(customConst.id);
    assert.equal(store.deleteConstructionModel(customConst.id), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 3: Automatic World Config XML parsing (get_config & get_unit_info) and automatic scheduler speed inheritance', () => {
  const sampleGetConfigXml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <config>
      <speed>1.6</speed>
      <unit_speed>0.625</unit_speed>
      <moral>1</moral>
      <game>
        <archer>0</archer>
        <knight>1</knight>
        <church>0</church>
        <watchtower>1</watchtower>
        <fake_limit>1</fake_limit>
      </game>
      <commands>
        <command_cancel_time>600</command_cancel_time>
        <attack_gap>100</attack_gap>
      </commands>
    </config>
  `;

  // Speed 2.0 * UnitSpeed 1.0 world unit_info example (ram = 15 min/field, snob = 17.5 min/field)
  const sampleUnitInfoXml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <config>
      <spear><speed>9</speed></spear>
      <ram><speed>15</speed></ram>
      <snob><speed>17.5</speed></snob>
    </config>
  `;

  const parsed = parseWorldConfigXml(sampleGetConfigXml, sampleUnitInfoXml);
  assert.equal(parsed.speed, 1.6);
  assert.equal(parsed.unitSpeed, 0.625);
  assert.equal(parsed.archer, false);
  assert.equal(parsed.paladin, true);
  assert.equal(parsed.watchtower, true);
  assert.equal(parsed.attackGapMs, 100);
  assert.equal(parsed.unitSpeeds.ram, 15);
  assert.equal(parsed.unitSpeeds.snob, 17.5);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wave3-test-'));
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({
      username: 'BR145Player',
      domain: 'tribalwars.com.br',
      world: 'br145',
    });

    store.saveWorldConfig(
      {
        worldKey: 'tribalwars.com.br:br145',
        domain: 'tribalwars.com.br',
        world: 'br145',
        ...parsed,
        fetchedAt: new Date().toISOString(),
      },
      acc._id
    );

    const arrivalMs = 1_800_000_000_000;
    // Create scheduled command WITHOUT passing manual worldSpeed/unitSpeed:
    // It should automatically inherit `unitSpeeds.ram = 15 min/field` from the saved br145 world config!
    const cmd = store.createScheduledCommand({
      accountId: acc._id,
      accountName: acc.username,
      originCoords: '500|500',
      targetCoords: '503|504', // 5 fields
      commandType: 'attack',
      slowestUnit: 'ram',
      troops: { axe: 6000, ram: 300 },
      waves: 1,
      arrivalTimeMs: arrivalMs,
      triggerBeforeMs: 30000,
    });

    // 5 fields * 15 min/field = 75 min = 4,500,000 ms
    assert.equal(cmd.distance, 5);
    assert.equal(cmd.travelTimeMs, 75 * 60 * 1000);
    assert.equal(cmd.sendTimeMs, arrivalMs - 75 * 60 * 1000);

    // Wave 3.1: Auto-detect slowest unit from troops (> 0) and support scheduling by exact Send Time ('send' mode)
    assert.equal(detectSlowestUnitFromTroops({}), null);
    assert.equal(detectSlowestUnitFromTroops({ spear: 0, axe: 0 }), null);
    assert.equal(detectSlowestUnitFromTroops({ spy: 5, light: 200, axe: 1000 }), 'axe');
    assert.equal(detectSlowestUnitFromTroops({ axe: 5000, ram: 250, snob: 1 }), 'snob');

    const explicitSendMs = 1_800_000_500_000;
    const cmdBySendTime = store.createScheduledCommand({
      accountId: acc._id,
      accountName: acc.username,
      originCoords: '500|500',
      targetCoords: '503|504', // 5 fields
      commandType: 'noble4',
      // Pass 'spy' as slowestUnit, but since troops has snob: 1, it must auto-override to 'snob' (17.5 min/field in br145)!
      slowestUnit: 'spy',
      troops: { axe: 200, snob: 1 },
      waves: 4,
      timingMode: 'send',
      sendTimeMs: explicitSendMs,
      triggerBeforeMs: 30000,
    });
    assert.equal(cmdBySendTime.slowestUnit, 'snob');
    assert.equal(cmdBySendTime.sendTimeMs, explicitSendMs);
    // 5 fields * 17.5 min/field = 87.5 min = 5,250,000 ms
    assert.equal(cmdBySendTime.travelTimeMs, 87.5 * 60 * 1000);
    assert.equal(cmdBySendTime.arrivalTimeMs, explicitSendMs + 87.5 * 60 * 1000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 3.2: Multi-Wave Per-Wave Troop Configuration and Presets Persistence', () => {
  // 1. Verify default Noble Train preset has distinct per-wave compositions (Wave 1: nuke + noble; Waves 2..4: escort + noble)
  const ntPreset = DEFAULT_SCHEDULER_PRESETS.find((p) => p.id === 'preset-nt25');
  assert.ok(ntPreset, 'preset-nt25 must exist in default presets');
  assert.equal(ntPreset.waves, 4);
  assert.ok(Array.isArray(ntPreset.allWavesTroops));
  assert.equal(ntPreset.allWavesTroops.length, 4);
  assert.equal(ntPreset.allWavesTroops[0].axe, 250);
  assert.equal(ntPreset.allWavesTroops[0].light, 100);
  assert.equal(ntPreset.allWavesTroops[0].snob, 1);
  assert.equal(ntPreset.allWavesTroops[1].axe, 250);
  assert.equal(ntPreset.allWavesTroops[1].snob, 1);
  assert.equal(ntPreset.allWavesTroops[2].snob, 1);
  assert.equal(ntPreset.allWavesTroops[3].snob, 1);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wave3-2-test-'));
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({
      username: 'NobleCommander',
      domain: 'tribalwars.com.br',
      world: 'br145',
    });

    const customWaves = [
      { axe: 6000, light: 2500, ram: 280, snob: 1 },
      { axe: 150, spy: 2, snob: 1 },
      { axe: 100, light: 50, snob: 1 },
    ];

    // 2. Schedule command with explicit per-wave troop configuration
    const cmd = store.createScheduledCommand({
      accountId: acc._id,
      accountName: acc.username,
      originCoords: '500|500',
      targetCoords: '505|502',
      commandType: 'noble4',
      slowestUnit: 'snob',
      troops: customWaves[0],
      allWavesTroops: customWaves,
      waves: 3,
      timingMode: 'arrival',
      arrivalTimeMs: 1_800_000_000_000,
      triggerBeforeMs: 30000,
    });

    assert.equal(cmd.waves, 3);
    assert.ok(Array.isArray(cmd.allWavesTroops));
    assert.equal(cmd.allWavesTroops.length, 3);
    assert.equal(cmd.allWavesTroops[0].axe, 6000);
    assert.equal(cmd.allWavesTroops[0].ram, 280);
    assert.equal(cmd.allWavesTroops[1].axe, 150);
    assert.equal(cmd.allWavesTroops[1].spy, 2);
    assert.equal(cmd.allWavesTroops[2].light, 50);

    // 3. Test persistence across Store reloads
    const reloadedStore = new DataStore(tmpDir);
    const savedList = reloadedStore.getScheduledCommands(acc._id);
    assert.equal(savedList.length, 1);
    assert.equal(savedList[0].waves, 3);
    assert.equal(savedList[0].allWavesTroops.length, 3);
    assert.deepEqual(savedList[0].allWavesTroops, customWaves);

    // 4. Test fallback when allWavesTroops is not passed
    const fallbackCmd = store.createScheduledCommand({
      accountId: acc._id,
      accountName: acc.username,
      originCoords: '500|500',
      targetCoords: '501|501',
      commandType: 'attack',
      slowestUnit: 'axe',
      troops: { axe: 1000 },
      waves: 2,
      timingMode: 'arrival',
      arrivalTimeMs: 1_800_000_000_000,
      triggerBeforeMs: 30000,
    });
    assert.equal(fallbackCmd.waves, 2);
    assert.ok(Array.isArray(fallbackCmd.allWavesTroops));
    assert.equal(fallbackCmd.allWavesTroops.length, 2);
    assert.equal(fallbackCmd.allWavesTroops[0].axe, 1000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 4: Combined Villages & Groups, Target Player Search (player.txt / village.txt), Attack Planner Matrix & Batch Scheduling', () => {
  // 1. Decode URL-encoded Tribal Wars strings (+ -> space, %XX -> UTF-8)
  assert.equal(decodeTwText('Rei+Arthur+%231'), 'Rei Arthur #1');

  // 2. Parse /map/player.txt and /map/village.txt
  const samplePlayersTxt = [
    '101,Lord+Vader,55,3,28500,12',
    '102,Vader+Junior,55,1,9200,84',
    '205,Outro+Jogador,10,2,15000,40',
  ].join('\n');

  const players = parseWorldPlayersTxt(samplePlayersTxt);
  assert.equal(players.length, 3);
  assert.equal(players[0].name, 'Lord Vader');
  assert.equal(players[0].villagesCount, 3);
  assert.equal(players[0].points, 28500);

  const playersById = new Map(players.map((p) => [p.id, p]));
  const sampleVillagesTxt = [
    '9001,Estrela+da+Morte,512,504,101,10000,1',
    '9002,Base+Sul,518,509,101,9500,2',
    '9003,Posto+K45,490,515,101,9000,3',
    '9004,Aldeia+Junior,520,510,102,9200,4',
    '9005,Aldeia+Inimiga+B,550,550,205,8000,5',
  ].join('\n');

  const targetVillages = parseWorldVillagesTxt(sampleVillagesTxt, playersById);
  assert.equal(targetVillages.length, 5);
  assert.equal(targetVillages[0].name, 'Estrela da Morte');
  assert.equal(targetVillages[0].coords, '512|504');
  // x=512, y=504 -> K + floor(504/100) + floor(512/100) = K55
  assert.equal(targetVillages[0].continent, 'K55');
  assert.equal(targetVillages[0].playerName, 'Lord Vader');
  // x=490, y=515 -> K + floor(515/100) + floor(490/100) = K54
  assert.equal(targetVillages[2].continent, 'K54');

  // 3. Search by player name substring and by coordinate
  const byName = searchTargetPlayerVillages({
    query: 'vader',
    players,
    villages: targetVillages,
  });
  assert.equal(byName.matchedPlayers.length, 2);
  // Prefix match ("Vader Junior") ranks ahead of mid-string match ("Lord Vader")
  assert.equal(byName.matchedPlayers[0].name, 'Vader Junior');
  assert.equal(byName.matchedPlayers[1].name, 'Lord Vader');
  assert.equal(byName.villages.length, 4);

  const byExact = searchTargetPlayerVillages({
    query: 'lord vader',
    players,
    villages: targetVillages,
  });
  assert.equal(byExact.matchedPlayers.length, 1);
  assert.equal(byExact.matchedPlayers[0].name, 'Lord Vader');
  assert.equal(byExact.villages.length, 3);

  const byCoord = searchTargetPlayerVillages({
    query: '550|550',
    players,
    villages: targetVillages,
  });
  assert.equal(byCoord.villages.length, 1);
  assert.equal(byCoord.villages[0].id, '9005');
  assert.equal(byCoord.matchedPlayers.length, 1);
  assert.equal(byCoord.matchedPlayers[0].name, 'Outro Jogador');

  // 4. Build Multi-Origin -> Multi-Target Matrix (nearest + round-robin + same-origin staggering)
  const origins = [
    {
      id: '10',
      name: '001 | Norte',
      coords: '500|500',
      x: 500,
      y: 500,
      points: 9500,
      wood: 0,
      stone: 0,
      iron: 0,
      storage: 0,
      pop: 0,
      popMax: 0,
      troops: { axe: 6500, light: 3000, ram: 300 },
      localCategory: 'Ofensiva',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: '11',
      name: '002 | Sul',
      coords: '520|520',
      x: 520,
      y: 520,
      points: 9500,
      wood: 0,
      stone: 0,
      iron: 0,
      storage: 0,
      pop: 0,
      popMax: 0,
      troops: { axe: 6000, light: 2800, ram: 280, snob: 4 },
      localCategory: 'Nobre / NT',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const targets = [
    { coords: '503|504', villageName: 'Alvo Perto do Norte', playerName: 'Alvo1' },
    { coords: '523|524', villageName: 'Alvo Perto do Sul', playerName: 'Alvo1' },
  ];
  const arrivalMs = 1_800_000_000_000;

  const nearestMatrix = buildAttackPlanMatrix({
    origins,
    targets,
    commandType: 'attack',
    slowestUnit: 'spy', // should auto-detect 'ram' from troops
    troops: { axe: 6000, ram: 250 },
    waves: 1,
    arrivalTimeMs: arrivalMs,
    worldSpeed: 1,
    unitSpeed: 1,
    allocationStrategy: 'nearest',
    maxCommandsPerOrigin: 1,
    commandsPerTarget: 1,
  });

  assert.equal(nearestMatrix.length, 2);
  const forNorte = nearestMatrix.find((i) => i.targetCoords === '503|504');
  const forSul = nearestMatrix.find((i) => i.targetCoords === '523|524');
  assert.equal(forNorte.originVillageId, '10');
  assert.equal(forSul.originVillageId, '11');
  assert.equal(forNorte.slowestUnit, 'ram');
  assert.equal(forNorte.distance, 5);
  assert.equal(forNorte.travelTimeMs, 150 * 60 * 1000);
  assert.equal(forNorte.sendTimeMs, arrivalMs - 150 * 60 * 1000);

  // Round-robin with 1 origin sending 2 commands at identical distance -> must auto-stagger +250ms
  const staggeredMatrix = buildAttackPlanMatrix({
    origins: [origins[0]],
    targets: [
      { coords: '503|504', villageName: 'Alvo A' },
      { coords: '504|503', villageName: 'Alvo B' },
    ],
    commandType: 'fake',
    slowestUnit: 'ram',
    troops: { spy: 5, ram: 1 },
    waves: 1,
    arrivalTimeMs: arrivalMs,
    allocationStrategy: 'round-robin',
    maxCommandsPerOrigin: 2,
    commandsPerTarget: 1,
  });
  assert.equal(staggeredMatrix.length, 2);
  assert.equal(
    Math.abs(staggeredMatrix[1].sendTimeMs - staggeredMatrix[0].sendTimeMs),
    250
  );

  // 5. DataStore village groups, preservation of localCategory/troops, and batch scheduled command creation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wave4-test-'));
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({ username: 'OPCoordinator', world: 'br130' });

    store.setAccountVillages(acc._id, origins);
    // Subsequent basic production sync without troops/localCategory must preserve them!
    const strippedVillages = origins.map(({ troops: _t, localCategory: _c, ...rest }) => rest);
    const preserved = store.setAccountVillages(acc._id, strippedVillages);
    assert.equal(preserved[0].localCategory, 'Ofensiva');
    assert.equal(preserved[0].troops.axe, 6500);

    store.setAccountVillageGroups(acc._id, [
      { id: '0', name: 'Todas' },
      { id: '42', name: 'Full Ataque' },
    ]);
    assert.equal(store.getAccountById(acc._id)?.villageGroups?.length, 2);

    const createdBatch = store.createBatchScheduledCommands(
      nearestMatrix.map((item) => ({
        accountId: acc._id,
        accountName: acc.username,
        originVillageId: item.originVillageId,
        originCoords: item.originCoords,
        targetCoords: item.targetCoords,
        commandType: item.commandType,
        slowestUnit: item.slowestUnit,
        troops: item.troops,
        waves: item.waves,
        allWavesTroops: item.allWavesTroops,
        timingMode: 'arrival',
        arrivalTimeMs: item.arrivalTimeMs,
        triggerBeforeMs: 30000,
      }))
    );
    assert.equal(createdBatch.length, 2);
    assert.equal(store.getScheduledCommands(acc._id).length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 5: Auto-Dodge Nearest Friendly Village Resolution, Evasion/Cancel Timing Math & Dodge Command Persistence', () => {
  const villages = [
    {
      id: '101',
      name: '001 | Capital Atacada',
      coords: '500|500',
      x: 500,
      y: 500,
      points: 9500,
      wood: 0,
      stone: 0,
      iron: 0,
      storage: 0,
      pop: 0,
      popMax: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: '102',
      name: '002 | Distante',
      coords: '530|540',
      x: 530,
      y: 540,
      points: 7000,
      wood: 0,
      stone: 0,
      iron: 0,
      storage: 0,
      pop: 0,
      popMax: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: '103',
      name: '003 | Vizinha Segura',
      coords: '502|501',
      x: 502,
      y: 501,
      points: 8200,
      wood: 0,
      stone: 0,
      iron: 0,
      storage: 0,
      pop: 0,
      popMax: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  // 1. Nearest friendly village resolution (skipping origin village 500|500)
  const nearest = findNearestFriendlyVillage('500|500', villages);
  assert.ok(nearest);
  assert.equal(nearest.id, '103');
  assert.equal(nearest.coords, '502|501');

  assert.equal(findNearestFriendlyVillage('500|500', [villages[0]]), null);

  // 2. Evasion & cancellation timing math
  const enemyImpactMs = 1_800_000_060_000;
  const timing = calculateAutoDodgeTiming({
    enemyArrivalTimeMs: enemyImpactMs,
    dodgeBeforeSec: 4,
    cancelAfterSec: 2,
    commandCancelLimitSec: 600,
  });
  assert.equal(timing.dodgeBeforeMs, 4000);
  assert.equal(timing.cancelAfterMs, 2000);
  assert.equal(timing.sendTimeMs, enemyImpactMs - 4000);
  assert.equal(timing.cancelTimeMs, enemyImpactMs + 2000);
  assert.equal(timing.travelBeforeCancelMs, 6000);
  assert.equal(timing.expectedReturnTimeMs, enemyImpactMs + 2000 + 6000);
  assert.equal(timing.withinCancelWindow, true);

  // Exceeding world cancel limit -> withinCancelWindow false
  const outOfWindow = calculateAutoDodgeTiming({
    enemyArrivalTimeMs: enemyImpactMs,
    dodgeBeforeSec: 60,
    cancelAfterSec: 60,
    commandCancelLimitSec: 120,
  });
  assert.equal(outOfWindow.withinCancelWindow, false);

  // 3. DataStore.createDodgeCommand with multi-village resolution + persistence + single-village fallback
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wave5-test-'));
  try {
    const store = new DataStore(tmpDir);
    const accMulti = store.createAccount({ username: 'DodgeTester', world: 'br130' });
    store.setAccountVillages(accMulti._id, villages);

    const dodgeCmd = store.createDodgeCommand({
      accountId: accMulti._id,
      originCoords: '500|500',
      incomingCommandId: 'inc-999',
      attackerName: 'InimigoK55',
      enemyArrivalTimeMs: enemyImpactMs,
      dodgeBeforeSec: 5,
      cancelAfterSec: 3,
      sendAllTroops: true,
    });

    assert.equal(dodgeCmd.commandType, 'support');
    assert.equal(dodgeCmd.originVillageId, '101');
    assert.equal(dodgeCmd.targetCoords, '502|501');
    assert.equal(dodgeCmd.sendTimeMs, enemyImpactMs - 5000);
    assert.ok(dodgeCmd.autoDodge?.enabled);
    assert.equal(dodgeCmd.autoDodge.incomingCommandId, 'inc-999');
    assert.equal(dodgeCmd.autoDodge.cancelTimeMs, enemyImpactMs + 3000);
    assert.equal(dodgeCmd.autoDodge.expectedReturnTimeMs, enemyImpactMs + 3000 + 8000);
    assert.equal(dodgeCmd.autoDodge.sendAllTroops, true);
    assert.equal(dodgeCmd.autoDodge.cancelStatus, 'pending');

    // Reload from disk and verify autoDodge metadata persisted
    const reloaded = new DataStore(tmpDir);
    const savedCmd = reloaded.getScheduledCommands(accMulti._id)[0];
    assert.ok(savedCmd.autoDodge?.enabled);
    assert.equal(savedCmd.autoDodge.cancelTimeMs, enemyImpactMs + 3000);

    // Single-village account fallback to adjacent coordinate
    const accSingle = store.createAccount({ username: 'SoloVillage', world: 'br130' });
    store.setAccountVillages(accSingle._id, [villages[0]]);
    const fallbackDodge = store.createDodgeCommand({
      accountId: accSingle._id,
      originCoords: '500|500',
      enemyArrivalTimeMs: enemyImpactMs,
    });
    assert.equal(fallbackDodge.targetCoords, '501|500');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 6: Auto-Snip Gap Detector, Viable Support Finder (Speed-Tiered Troops) & Precision Batch Scheduling', () => {
  const baseImpactMs = 1_800_010_000_000;

  // 1. detectSnipWindows: Limpeza -> Nobre 1 -> Nobre 2 on 500|500 + Standard gap on 510|510
  const incomings = [
    {
      id: 'acc1-c4',
      accountId: 'acc1',
      accountName: 'DefensorBR',
      commandId: 'c4',
      originName: 'InimigoB',
      originCoords: '520|520',
      targetName: '002 | Secundária',
      targetCoords: '510|510',
      attackerName: 'Atacante2',
      arrivalTimeMs: baseImpactMs + 10_000,
      remainingSec: 600,
      distance: 14.14,
      detectedUnit: 'Bárbaro',
      label: 'Fake 1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'acc1-c5',
      accountId: 'acc1',
      accountName: 'DefensorBR',
      commandId: 'c5',
      originName: 'InimigoB',
      originCoords: '520|520',
      targetName: '002 | Secundária',
      targetCoords: '510|510',
      attackerName: 'Atacante2',
      arrivalTimeMs: baseImpactMs + 15_000,
      remainingSec: 605,
      distance: 14.14,
      detectedUnit: 'Bárbaro',
      label: 'Fake 2',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    // Intentionally unsorted order on target 500|500
    {
      id: 'acc1-c3',
      accountId: 'acc1',
      accountName: 'DefensorBR',
      commandId: 'c3',
      originName: 'InimigoA',
      originCoords: '495|495',
      targetName: '001 | Capital',
      targetCoords: '500|500',
      attackerName: 'Atacante1',
      arrivalTimeMs: baseImpactMs + 370,
      remainingSec: 590,
      distance: 7.07,
      detectedUnit: 'Nobre',
      label: 'Nobre 2',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'acc1-c1',
      accountId: 'acc1',
      accountName: 'DefensorBR',
      commandId: 'c1',
      originName: 'InimigoA',
      originCoords: '495|495',
      targetName: '001 | Capital',
      targetCoords: '500|500',
      attackerName: 'Atacante1',
      arrivalTimeMs: baseImpactMs + 100,
      remainingSec: 590,
      distance: 7.07,
      detectedUnit: 'Aríete / Catapulta',
      label: 'Limpeza Full',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'acc1-c2',
      accountId: 'acc1',
      accountName: 'DefensorBR',
      commandId: 'c2',
      originName: 'InimigoA',
      originCoords: '495|495',
      targetName: '001 | Capital',
      targetCoords: '500|500',
      attackerName: 'Atacante1',
      arrivalTimeMs: baseImpactMs + 250,
      remainingSec: 590,
      distance: 7.07,
      detectedUnit: 'Nobre',
      label: 'Nobre 1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const gaps = detectSnipWindows(incomings);
  assert.equal(gaps.length, 3);
  // Priority order: critical_noble (c1 -> c2), noble_train (c2 -> c3), standard (c4 -> c5)
  assert.equal(gaps[0].priority, 'critical_noble');
  assert.equal(gaps[0].targetCoords, '500|500');
  assert.equal(gaps[0].firstAttackId, 'c1');
  assert.equal(gaps[0].secondAttackId, 'c2');
  assert.equal(gaps[0].gapMs, 150);
  assert.equal(gaps[0].windowStartMs, baseImpactMs + 110);
  assert.equal(gaps[0].windowEndMs, baseImpactMs + 240);
  assert.equal(gaps[0].recommendedArrivalMs, baseImpactMs + 175);

  assert.equal(gaps[1].priority, 'noble_train');
  assert.equal(gaps[1].gapMs, 120);
  assert.equal(gaps[2].priority, 'standard');
  assert.equal(gaps[2].gapMs, 5000);

  // 2. findViableSnipSupports: distance = 5 fields (503|504 -> 500|500)
  // Speed 1.0x: heavy = 55m, spear = 90m, sword = 110m, catapult = 150m
  const villages = [
    {
      id: 'v-target',
      name: '001 | Capital',
      coords: '500|500',
      x: 500,
      y: 500,
      points: 9500,
      wood: 0,
      stone: 0,
      iron: 0,
      storage: 0,
      pop: 0,
      popMax: 0,
      troops: { spear: 500, heavy: 100 },
      localCategory: 'Defensiva',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'v-def1',
      name: '002 | Muralha Sul',
      coords: '503|504',
      x: 503,
      y: 504,
      points: 9200,
      wood: 0,
      stone: 0,
      iron: 0,
      storage: 0,
      pop: 0,
      popMax: 0,
      troops: { spear: 1500, sword: 1200, heavy: 400, catapult: 10 },
      localCategory: 'Defensiva',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'v-off1',
      name: '003 | Ataque Front',
      coords: '500|503',
      x: 500,
      y: 503,
      points: 9400,
      wood: 0,
      stone: 0,
      iron: 0,
      storage: 0,
      pop: 0,
      popMax: 0,
      troops: { axe: 6000, light: 2500, spear: 200 },
      localCategory: 'Ofensiva',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  // With 100 minutes left until target arrival, heavy (55m) and spear (90m) are viable; sword (110m) & catapult (150m) passed!
  const targetArrival = gaps[0].recommendedArrivalMs;
  const now100mBefore = targetArrival - 100 * 60 * 1000;

  const defCandidates = findViableSnipSupports({
    accountId: 'acc1',
    accountName: 'DefensorBR',
    targetCoords: '500|500',
    windowStartMs: gaps[0].windowStartMs,
    windowEndMs: gaps[0].windowEndMs,
    targetArrivalMs: targetArrival,
    villages,
    groupFilter: 'Defensiva',
    nowMs: now100mBefore,
    minLeadTimeMs: 15000,
    worldSpeed: 1,
    unitSpeed: 1,
  });

  // Only v-def1 matches 'Defensiva' (target self is excluded), and only spear (90m) & heavy (55m) have leadTime > 0
  assert.equal(defCandidates.length, 2);
  // Sorted chronologically by sendTimeMs (spear has to launch first: T-90m, then heavy: T-55m)
  assert.equal(defCandidates[0].originVillageId, 'v-def1');
  assert.equal(defCandidates[0].slowestUnit, 'spear');
  assert.equal(defCandidates[0].travelTimeMs, 90 * 60 * 1000);
  assert.equal(defCandidates[0].sendTimeMs, targetArrival - 90 * 60 * 1000);
  assert.equal(defCandidates[0].suggestedTroops.spear, 1500);
  assert.equal(defCandidates[0].suggestedTroops.heavy, 400);
  assert.equal(defCandidates[0].suggestedTroops.sword, undefined);
  assert.equal(defCandidates[0].suggestedTroops.catapult, undefined);

  assert.equal(defCandidates[1].slowestUnit, 'heavy');
  assert.equal(defCandidates[1].travelTimeMs, 55 * 60 * 1000);
  assert.equal(defCandidates[1].suggestedTroops.heavy, 400);
  assert.equal(defCandidates[1].suggestedTroops.spear, undefined);

  // With 160 minutes left, catapult anchor (150m) drags ALL faster defensive troops (spear + sword + heavy + catapult)
  const allSpeedCandidates = findViableSnipSupports({
    accountId: 'acc1',
    accountName: 'DefensorBR',
    targetCoords: '500|500',
    windowStartMs: gaps[0].windowStartMs,
    windowEndMs: gaps[0].windowEndMs,
    targetArrivalMs: targetArrival,
    villages: [villages[1]],
    nowMs: targetArrival - 160 * 60 * 1000,
    minLeadTimeMs: 15000,
    worldSpeed: 1,
    unitSpeed: 1,
  });
  const catAnchor = allSpeedCandidates.find((c) => c.slowestUnit === 'catapult');
  assert.ok(catAnchor);
  assert.equal(catAnchor.travelTimeMs, 150 * 60 * 1000);
  assert.equal(catAnchor.suggestedTroops.catapult, 10);
  assert.equal(catAnchor.suggestedTroops.sword, 1200);
  assert.equal(catAnchor.suggestedTroops.spear, 1500);
  assert.equal(catAnchor.suggestedTroops.heavy, 400);

  // 3. Precision batch scheduling in DataStore preserves ms arrivalTimeMs & anchor unit
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wave6-test-'));
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({ username: 'DefensorBR', world: 'br130' });
    const scheduled = store.createBatchScheduledCommands(
      defCandidates.map((cand) => ({
        accountId: acc._id,
        accountName: acc.username,
        originVillageId: cand.originVillageId,
        originCoords: cand.originCoords,
        targetCoords: cand.targetCoords,
        commandType: 'support',
        presetName: `Auto-Snip (${cand.unitLabel})`,
        slowestUnit: cand.slowestUnit,
        troops: cand.suggestedTroops,
        waves: 1,
        timingMode: 'arrival',
        arrivalTimeMs: cand.arrivalTimeMs,
        triggerBeforeMs: 30000,
        worldSpeed: 1,
        unitSpeed: 1,
        notes: 'Auto-Snip Teste Wave 6',
      }))
    );

    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[0].commandType, 'support');
    assert.equal(scheduled[0].slowestUnit, 'spear');
    assert.equal(scheduled[0].arrivalTimeMs, targetArrival);
    assert.equal(scheduled[0].sendTimeMs, targetArrival - 90 * 60 * 1000);
    assert.equal(scheduled[1].slowestUnit, 'heavy');
    assert.equal(scheduled[1].sendTimeMs, targetArrival - 55 * 60 * 1000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 7: Auto-Farm Plunder Filtering, Humanized Delays, Player Routes Cooldown, Safety Stops & Config Persistence', () => {
  const cfg = createDefaultAutoFarmConfig('acc-farm');
  cfg.templateKey = 'a';
  cfg.maxDistance = 15;
  cfg.allowYellowReports = false;
  cfg.minReserveLight = 50;
  cfg.minReserveSpear = 0;

  // 1. filterPlunderTargets: excludes red, yellow (when disabled), > maxDistance, or disabled template A
  const plunderTargets = [
    {
      villageId: '1',
      coords: '502|501',
      name: 'Aldeia de Bárbaros',
      distance: 2.2,
      lastReportStatus: 'green',
      hasFullLoot: true,
      canSendA: true,
      canSendB: true,
      canSendC: false,
    },
    {
      villageId: '2',
      coords: '505|505',
      name: 'Bárbara Amarela',
      distance: 7.0,
      lastReportStatus: 'yellow',
      hasFullLoot: false,
      canSendA: true,
      canSendB: true,
      canSendC: false,
    },
    {
      villageId: '3',
      coords: '501|500',
      name: 'Bárbara Vermelha',
      distance: 1.0,
      lastReportStatus: 'red',
      canSendA: true,
      canSendB: true,
      canSendC: false,
    },
    {
      villageId: '4',
      coords: '530|530',
      name: 'Bárbara Longe',
      distance: 42.4,
      lastReportStatus: 'green',
      canSendA: true,
      canSendB: true,
      canSendC: false,
    },
    {
      villageId: '5',
      coords: '501|502',
      name: 'Sem Botão A',
      distance: 2.0,
      lastReportStatus: 'green',
      canSendA: false,
      canSendB: true,
      canSendC: false,
    },
  ];

  const safeOnly = filterPlunderTargets(plunderTargets, cfg);
  assert.equal(safeOnly.length, 1);
  assert.equal(safeOnly[0].villageId, '1');

  const withYellow = filterPlunderTargets(plunderTargets, { ...cfg, allowYellowReports: true });
  assert.equal(withYellow.length, 2);
  assert.equal(withYellow[0].villageId, '1');
  assert.equal(withYellow[1].villageId, '2');

  // 2. computeHumanizedDelayMs stays strictly within [min, max]
  assert.equal(computeHumanizedDelayMs(250, 600, () => 0), 250);
  assert.equal(computeHumanizedDelayMs(250, 600, () => 0.99999), 600);
  const midDelay = computeHumanizedDelayMs(250, 600, () => 0.5);
  assert.ok(midDelay >= 250 && midDelay <= 600);

  // 3. selectDuePlayerFarmTargets respects enabled flag & cooldown minutes
  const nowMs = 1_800_050_000_000;
  const routes = [
    {
      id: 'r1',
      coords: '510|512',
      playerName: 'Inativo1',
      troops: { light: 80, spy: 1 },
      minIntervalMinutes: 30,
      lastAttackedAt: new Date(nowMs - 45 * 60 * 1000).toISOString(), // 45m ago -> due
      enabled: true,
    },
    {
      id: 'r2',
      coords: '511|512',
      playerName: 'Inativo2',
      troops: { light: 80 },
      minIntervalMinutes: 30,
      lastAttackedAt: new Date(nowMs - 10 * 60 * 1000).toISOString(), // 10m ago -> cooldown
      enabled: true,
    },
    {
      id: 'r3',
      coords: '512|512',
      playerName: 'Desativado',
      troops: { light: 50 },
      minIntervalMinutes: 15,
      enabled: false,
    },
  ];
  const due = selectDuePlayerFarmTargets(routes, nowMs);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, 'r1');

  // 4. evaluateFarmSafetyStop: CAPTCHA, Incomings, Low Troops, Daily Limit
  assert.equal(
    evaluateFarmSafetyStop({ config: cfg, captchaDetected: true, incomingsCount: 0 }).reason,
    'captcha'
  );
  assert.equal(
    evaluateFarmSafetyStop({ config: cfg, captchaDetected: false, incomingsCount: 2 }).reason,
    'incomings'
  );
  assert.equal(
    evaluateFarmSafetyStop({
      config: cfg,
      captchaDetected: false,
      incomingsCount: 0,
      attacksToday: 600,
    }).reason,
    'daily_limit'
  );
  assert.equal(
    evaluateFarmSafetyStop({
      config: cfg,
      captchaDetected: false,
      incomingsCount: 0,
      currentTroops: { light: 40, spear: 0 },
    }).reason,
    'low_troops'
  );
  assert.equal(
    evaluateFarmSafetyStop({
      config: cfg,
      captchaDetected: false,
      incomingsCount: 0,
      attacksToday: 120,
      currentTroops: { light: 400, spear: 200 },
    }).shouldStop,
    false
  );

  // 5. DataStore persistence of AutoFarmConfig & markPlayerFarmTargetAttacked
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wave7-test-'));
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({ username: 'FarmerBR', world: 'br130' });
    store.saveAutoFarmConfig({
      accountId: acc._id,
      mode: 'both',
      templateKey: 'b',
      maxDistance: 25,
      minReserveLight: 100,
      playerTargets: [routes[0]],
    });

    const attackIso = '2026-11-17T14:30:00.000Z';
    store.markPlayerFarmTargetAttacked(acc._id, 'r1', attackIso);

    const reloaded = new DataStore(tmpDir);
    const savedCfg = reloaded.getAutoFarmConfig(acc._id);
    assert.equal(savedCfg.mode, 'both');
    assert.equal(savedCfg.templateKey, 'b');
    assert.equal(savedCfg.maxDistance, 25);
    assert.equal(savedCfg.minReserveLight, 100);
    assert.equal(savedCfg.playerTargets.length, 1);
    assert.equal(savedCfg.playerTargets[0].lastAttackedAt, attackIso);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Planner manual builder supports per-attack arrival/send modes, optional sync, and mixed batch enqueue', () => {
  const origin1 = {
    id: 'v1',
    name: 'Aldeia 01',
    coords: '500|500',
    x: 500,
    y: 500,
    points: 10000,
    troops: { axe: 6500, light: 3000, ram: 300 },
  };
  const origin2 = {
    id: 'v2',
    name: 'Aldeia 02',
    coords: '500|510',
    x: 500,
    y: 510,
    points: 9500,
    troops: { spy: 50, snob: 4 },
  };

  const arrivalTargetMs = Date.UTC(2026, 5, 1, 12, 0, 0);
  const sendTargetMs = Date.UTC(2026, 5, 1, 10, 30, 0);

  // 1) Manual attack in 'arrival' mode (distance 10, ram speed 30 min/field = 300 min)
  const itemArrival = buildManualAttackPlanItem({
    id: 'm1',
    origin: origin1,
    target: { coords: '510|500', playerName: 'Alvo1' },
    commandType: 'attack',
    presetName: 'Full Ataque',
    slowestUnit: 'ram',
    troops: { axe: 6500, ram: 300 },
    waves: 1,
    timingMode: 'arrival',
    targetTimeMs: arrivalTargetMs,
    worldSpeed: 1,
    unitSpeed: 1,
    notes: 'Ataque 1',
  });
  assert.ok(itemArrival);
  assert.equal(itemArrival.timingMode, 'arrival');
  assert.equal(itemArrival.distance, 10);
  assert.equal(itemArrival.travelTimeMs, 300 * 60 * 1000);
  assert.equal(itemArrival.arrivalTimeMs, arrivalTargetMs);
  assert.equal(itemArrival.sendTimeMs, arrivalTargetMs - 300 * 60 * 1000);

  // 2) Manual attack in 'send' mode (distance 10, snob speed 35 min/field = 350 min)
  const itemSend = buildManualAttackPlanItem({
    id: 'm2',
    origin: origin2,
    target: { coords: '510|510', playerName: 'Alvo2' },
    commandType: 'noble4',
    presetName: 'NT 4x',
    slowestUnit: 'snob',
    troops: { axe: 100, snob: 1 },
    waves: 4,
    timingMode: 'send',
    targetTimeMs: sendTargetMs,
    worldSpeed: 1,
    unitSpeed: 1,
    notes: 'NT 2',
  });
  assert.ok(itemSend);
  assert.equal(itemSend.timingMode, 'send');
  assert.equal(itemSend.waves, 4);
  assert.equal(itemSend.travelTimeMs, 350 * 60 * 1000);
  assert.equal(itemSend.sendTimeMs, sendTargetMs);
  assert.equal(itemSend.arrivalTimeMs, sendTargetMs + 350 * 60 * 1000);

  // 3) Optional synchronized send applied only to selected item ('m1')
  const syncedSendTime = Date.UTC(2026, 5, 1, 11, 0, 0);
  const syncedList = applySyncTimingToPlanItems(
    [itemArrival, itemSend],
    'send',
    syncedSendTime,
    new Set(['m1'])
  );
  assert.equal(syncedList[0].timingMode, 'send');
  assert.equal(syncedList[0].sendTimeMs, syncedSendTime);
  assert.equal(syncedList[0].arrivalTimeMs, syncedSendTime + 300 * 60 * 1000);
  // Unselected item 'm2' remains unchanged
  assert.equal(syncedList[1].sendTimeMs, sendTargetMs);

  // 4) Anti-collision stagger when two attacks share same origin in sync-send mode
  const itemSameOrigin = buildManualAttackPlanItem({
    id: 'm3',
    origin: origin1,
    target: { coords: '505|500' },
    commandType: 'fake',
    slowestUnit: 'ram',
    troops: { ram: 1 },
    timingMode: 'arrival',
    targetTimeMs: arrivalTargetMs,
  });
  const staggered = applySyncTimingToPlanItems(
    [itemArrival, itemSameOrigin],
    'send',
    syncedSendTime
  );
  assert.equal(staggered[0].sendTimeMs, syncedSendTime);
  assert.equal(staggered[1].sendTimeMs, syncedSendTime + 250);

  // 5) Mixed batch enqueue ('arrival' + 'send') into DataStore
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-planner-manual-'));
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({
      username: 'TesterOp',
      server: 'br130',
      worldUrl: 'https://br130.tribalwars.com.br',
      villages: [origin1, origin2],
    });
    const batch = store.createBatchScheduledCommands([
      {
        accountId: acc._id,
        accountName: acc.username,
        originVillageId: itemArrival.originVillageId,
        originCoords: itemArrival.originCoords,
        targetCoords: itemArrival.targetCoords,
        commandType: itemArrival.commandType,
        slowestUnit: itemArrival.slowestUnit,
        troops: itemArrival.troops,
        waves: itemArrival.waves,
        timingMode: 'arrival',
        arrivalTimeMs: itemArrival.arrivalTimeMs,
        worldSpeed: 1,
        unitSpeed: 1,
      },
      {
        accountId: acc._id,
        accountName: acc.username,
        originVillageId: itemSend.originVillageId,
        originCoords: itemSend.originCoords,
        targetCoords: itemSend.targetCoords,
        commandType: itemSend.commandType,
        slowestUnit: itemSend.slowestUnit,
        troops: itemSend.troops,
        waves: itemSend.waves,
        timingMode: 'send',
        sendTimeMs: itemSend.sendTimeMs,
        worldSpeed: 1,
        unitSpeed: 1,
      },
    ]);
    assert.equal(batch.length, 2);
    const cmdArrival = batch.find((c) => c.originCoords === '500|500');
    const cmdSend = batch.find((c) => c.originCoords === '500|510');
    assert.equal(cmdArrival.arrivalTimeMs, arrivalTargetMs);
    assert.equal(cmdArrival.sendTimeMs, arrivalTargetMs - 300 * 60 * 1000);
    assert.equal(cmdSend.sendTimeMs, sendTargetMs);
    assert.equal(cmdSend.arrivalTimeMs, sendTargetMs + 350 * 60 * 1000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Scheduler regression: scheduled send-mode commands never fire immediately on schedule and reject past/invalid times', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-scheduler-regression-'));
  const calls = { prepare: [], dispatch: [], released: [] };
  const mockSessionManager = {
    prepareRallyPoint: async (cmd) => {
      calls.prepare.push(cmd.id);
      return { success: true, prepared: true };
    },
    dispatchRallyPointCommand: async (cmd) => {
      calls.dispatch.push(cmd.id);
      return { success: true };
    },
    cancelRallyPointCommand: async () => ({ success: true }),
    releaseCommandWindow: (id) => {
      calls.released.push(id);
    },
  };

  let scheduler = null;
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({
      username: 'TimerTester',
      domain: 'tribalwars.com.br',
      world: 'br130',
    });

    // 1. DataStore rejects missing/NaN timestamps instead of falling back to Date.now()
    assert.throws(
      () =>
        store.createScheduledCommand({
          accountId: acc._id,
          accountName: acc.username,
          originCoords: '500|500',
          targetCoords: '503|504',
          commandType: 'attack',
          slowestUnit: 'ram',
          troops: { axe: 100, ram: 10 },
          waves: 1,
          timingMode: 'send',
          sendTimeMs: Number.NaN,
          triggerBeforeMs: 30000,
        }),
      /sendTimeMs/
    );
    assert.throws(
      () =>
        store.createScheduledCommand({
          accountId: acc._id,
          accountName: acc.username,
          originCoords: '500|500',
          targetCoords: '503|504',
          commandType: 'attack',
          slowestUnit: 'ram',
          troops: { axe: 100, ram: 10 },
          waves: 1,
          timingMode: 'arrival',
          arrivalTimeMs: undefined,
          triggerBeforeMs: 30000,
        }),
      /arrivalTimeMs/
    );

    // 2. Future send-mode command persists exact sendTimeMs and arrivalTimeMs
    const futureSendMs = Date.now() + 10 * 60 * 1000;
    const futureCmd = store.createScheduledCommand({
      accountId: acc._id,
      accountName: acc.username,
      originCoords: '500|500',
      targetCoords: '503|504', // 5 fields * 30 min/field = 150 min
      commandType: 'attack',
      slowestUnit: 'ram',
      troops: { axe: 500, ram: 20 },
      waves: 1,
      timingMode: 'send',
      sendTimeMs: futureSendMs,
      triggerBeforeMs: 30000,
      worldSpeed: 1,
      unitSpeed: 1,
    });
    assert.equal(futureCmd.sendTimeMs, futureSendMs);
    assert.equal(futureCmd.arrivalTimeMs, futureSendMs + 150 * 60 * 1000);

    scheduler = new SchedulerService(store, mockSessionManager);
    scheduler.scheduleCommandTimers(futureCmd);

    // Also verify far-future (> 2_000_000_000 ms) re-arm path does not fire early
    const farFutureCmd = store.createScheduledCommand({
      accountId: acc._id,
      accountName: acc.username,
      originCoords: '500|500',
      targetCoords: '503|504',
      commandType: 'attack',
      slowestUnit: 'ram',
      troops: { axe: 100, ram: 5 },
      waves: 1,
      timingMode: 'send',
      sendTimeMs: Date.now() + 2_500_000_000,
      triggerBeforeMs: 30000,
      worldSpeed: 1,
      unitSpeed: 1,
    });
    scheduler.scheduleCommandTimers(farFutureCmd);

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(calls.prepare.length, 0, 'Future command must NOT pre-warm immediately');
    assert.equal(calls.dispatch.length, 0, 'Future command must NOT dispatch immediately');
    assert.equal(
      store.getScheduledCommands(acc._id).find((c) => c.id === futureCmd.id)?.status,
      'scheduled'
    );
    assert.equal(
      store.getScheduledCommands(acc._id).find((c) => c.id === farFutureCmd.id)?.status,
      'scheduled'
    );
    assert.equal(scheduler.getStats().activeTimers, 2);

    // 3. Past sendTimeMs must mark failed and NEVER dispatch immediately
    const pastCmd = store.createScheduledCommand({
      accountId: acc._id,
      accountName: acc.username,
      originCoords: '500|500',
      targetCoords: '503|504',
      commandType: 'attack',
      slowestUnit: 'ram',
      troops: { axe: 100, ram: 5 },
      waves: 1,
      timingMode: 'send',
      sendTimeMs: Date.now() - 5000,
      triggerBeforeMs: 30000,
      worldSpeed: 1,
      unitSpeed: 1,
    });
    scheduler.scheduleCommandTimers(pastCmd);

    // 4. NaN sendTimeMs (simulating corrupted command) must mark failed and NEVER dispatch
    const nanCmd = { ...pastCmd, id: 'nan-cmd-test', sendTimeMs: Number.NaN };
    scheduler.scheduleCommandTimers(nanCmd);

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(calls.prepare.length, 0, 'Past/invalid command must NOT prepare');
    assert.equal(calls.dispatch.length, 0, 'Past/invalid command must NOT dispatch');
    const updatedPast = store.getScheduledCommands(acc._id).find((c) => c.id === pastCmd.id);
    assert.equal(updatedPast?.status, 'failed');
    assert.match(updatedPast?.error || '', /inválido ou já expirado/i);
  } finally {
    if (scheduler) scheduler.clearAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 7.2: Per-Village Auto-Farm Configs, Duplicate Target Detection & Mapped Targets Filtering', () => {
  const targetA = {
    villageId: '901',
    coords: '502|501',
    name: 'Bárbara Norte',
    distance: 2.2,
    lastReportStatus: 'green',
    canSendA: true,
    canSendB: true,
    canSendC: false,
  };
  const targetShared = {
    villageId: '902',
    coords: '504|504',
    name: 'Bárbara Central (Duplicada)',
    distance: 5.6,
    lastReportStatus: 'green',
    canSendA: true,
    canSendB: true,
    canSendC: false,
  };
  const targetC = {
    villageId: '903',
    coords: '508|509',
    name: 'Bárbara Sul',
    distance: 4.1,
    lastReportStatus: 'green',
    canSendA: true,
    canSendB: true,
    canSendC: false,
  };

  // 1. filterPlunderTargets respects restrictToMappedTargets whitelist
  const cfgRestricted = createDefaultAutoFarmConfig('acc1', {
    id: 'acc1:v1',
    originVillageId: 'v1',
    originCoords: '500|500',
    restrictToMappedTargets: true,
    mappedTargets: [targetA],
  });
  const filteredRestricted = filterPlunderTargets(
    [targetA, targetShared, targetC],
    cfgRestricted
  );
  assert.equal(filteredRestricted.length, 1);
  assert.equal(filteredRestricted[0].coords, '502|501');

  // 2. findDuplicateFarmTargets detects overlapping targets across 2+ configs of same account
  const cfgV1 = createDefaultAutoFarmConfig('acc1', {
    id: 'acc1:v1',
    name: '001 | Norte (500|500)',
    originVillageId: 'v1',
    originCoords: '500|500',
    mappedTargets: [targetA, targetShared],
  });
  const cfgV2 = createDefaultAutoFarmConfig('acc1', {
    id: 'acc1:v2',
    name: '002 | Sul (506|507)',
    originVillageId: 'v2',
    originCoords: '506|507',
    mappedTargets: [targetShared, targetC],
  });

  const dupSummary = findDuplicateFarmTargets([cfgV1, cfgV2]);
  assert.equal(Object.keys(dupSummary.duplicatesByCoord).length, 1);
  assert.ok(dupSummary.duplicatesByCoord['504|504']);
  assert.equal(dupSummary.duplicatesByCoord['504|504'].length, 2);
  assert.equal(dupSummary.duplicateCountByConfigId['acc1:v1'], 1);
  assert.equal(dupSummary.duplicateCountByConfigId['acc1:v2'], 1);

  // 3. DataStore CRUD for multiple per-village configs + deleteAutoFarmConfig
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wave7-village-'));
  try {
    const store = new DataStore(tmpDir);
    const acc = store.createAccount({ username: 'MultiFarmer', world: 'br130' });

    store.saveAutoFarmConfig({ ...cfgV1, accountId: acc._id, id: `${acc._id}:v1` });
    store.saveAutoFarmConfig({ ...cfgV2, accountId: acc._id, id: `${acc._id}:v2` });

    const reloaded = new DataStore(tmpDir);
    const list = reloaded.getAutoFarmConfigsByAccount(acc._id);
    assert.equal(list.length, 2);
    assert.equal(list.find((c) => c.originVillageId === 'v1')?.mappedTargets.length, 2);
    assert.equal(list.find((c) => c.originVillageId === 'v2')?.mappedTargets.length, 2);

    assert.equal(reloaded.deleteAutoFarmConfig(`${acc._id}:v1`), true);
    assert.equal(reloaded.getAutoFarmConfigsByAccount(acc._id).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 7.3: Template Priority Order (A -> B), Coverage Resumption & Template C Follow-up Filtering', () => {
  const cfg = createDefaultAutoFarmConfig('acc-prio', {
    templateKey: 'a',
    templatePriorityOrder: ['a', 'b'],
    enableTemplateCFollowUp: true,
    maxDistance: 20,
  });

  assert.deepEqual(getEffectiveTemplateOrder(cfg), ['a', 'b']);

  const targets = [
    {
      villageId: '1',
      coords: '501|500',
      name: 'Bárbara 1',
      distance: 1.0,
      lastReportStatus: 'green',
      canSendA: true,
      canSendB: false,
      canSendC: true,
    },
    {
      villageId: '2',
      coords: '502|500',
      name: 'Bárbara 2 (Só B e C)',
      distance: 2.0,
      lastReportStatus: 'green',
      canSendA: false,
      canSendB: true,
      canSendC: true,
    },
    {
      villageId: '3',
      coords: '503|500',
      name: 'Bárbara 3 (A, B, C)',
      distance: 3.0,
      lastReportStatus: 'green',
      canSendA: true,
      canSendB: true,
      canSendC: false,
    },
  ];

  // 1. Primary phase accepts targets with either A or B enabled, ordered by proximity
  const primaryAll = filterPlunderTargetsForPhase(targets, cfg, 'primary', []);
  assert.equal(primaryAll.length, 3);
  assert.deepEqual(
    primaryAll.map((t) => t.coords),
    ['501|500', '502|500', '503|500']
  );

  // 2. Resuming after troops returned: skips already covered coords (501|500, 502|500)
  const primaryResumed = filterPlunderTargetsForPhase(targets, cfg, 'primary', ['501|500', '502|500']);
  assert.equal(primaryResumed.length, 1);
  assert.equal(primaryResumed[0].coords, '503|500');

  // 3. Template C follow-up phase selects only targets with canSendC enabled, ordered by proximity
  const phaseC = filterPlunderTargetsForPhase(targets, cfg, 'template_c', []);
  assert.equal(phaseC.length, 2);
  assert.deepEqual(
    phaseC.map((t) => t.coords),
    ['501|500', '502|500']
  );

  // 4. Daily schedule helper: same day if HH:MM is in the future, next day if already passed
  const refMorning = new Date(2026, 10, 23, 7, 30, 0, 0).getTime();
  const nextSameDay = new Date(computeNextDailyScheduleMs('08:00', refMorning));
  assert.equal(nextSameDay.getDate(), 23);
  assert.equal(nextSameDay.getHours(), 8);
  assert.equal(nextSameDay.getMinutes(), 0);

  const refAfternoon = new Date(2026, 10, 23, 14, 0, 0, 0).getTime();
  const nextTomorrow = new Date(computeNextDailyScheduleMs('08:00', refAfternoon));
  assert.equal(nextTomorrow.getDate(), 24);
  assert.equal(nextTomorrow.getHours(), 8);
  assert.equal(nextTomorrow.getMinutes(), 0);
});
