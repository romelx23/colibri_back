const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateName, keysOf } = require('../src/utils/sanitizeName');

test('nicks legítimos pasan el filtro', () => {
  const valid = [
    'Romel', 'Ana Maria', 'SoyElMejor', 'Ñandu 22', 'España Real',
    'Will2026', 'Download', 'Robot', 'Classic', 'cocacola',
    'Computo', 'ComputoMental', 'IconoGamer', 'Disputa23', 'Cacatua',
    'speed', 'Speedy', 'Tecno10', 'WiFi Libre',
  ];
  for (const name of valid) {
    const r = validateName(name);
    assert.equal(r.ok, true, `debía pasar: ${name} (${r.reason || ''})`);
  }
});

test('groserías y evasiones se bloquean', () => {
  const blocked = [
    'pendejo', 'P.e.n.d.e.j.o', 'puuuuto', 'Puut0Grande', 'put4',
    'IdiotaMX', 'Maricon', 'coño', 'cono', 'Fucking', 'nazi',
    'onlyfans_x', 'hackear', 'PussyCat', 'bitch', '100putos',
    'PutoCompu', 'compu put0', 'P.E.N.D.E.J.O', 'Putito', 'Hackerman',
  ];
  for (const name of blocked) {
    const r = validateName(name);
    assert.equal(r.ok, false, `debía bloquear: ${name}`);
  }
});

test('reglas de longitud y caracteres', () => {
  assert.equal(validateName('A').ok, false);
  assert.equal(validateName('x'.repeat(25)).ok, false);
  assert.equal(validateName('con@spam').ok, false);
  assert.equal(validateName('http://malo').ok, false);
  assert.equal(validateName('').ok, false);
  assert.equal(validateName(null).ok, false);
});

test('limpia espacios sobrantes', () => {
  const r = validateName('  Romel   Lopez  ');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Romel Lopez');
});

test('keysOf colapsa repeticiones y resuelve leet', () => {
  assert.deepEqual(keysOf('Puut0'), { raw: 'puuto', collapsed: 'puto' });
  assert.deepEqual(keysOf('puuuuto'), { raw: 'puuuuto', collapsed: 'puto' });
  assert.equal(keysOf('WWW').raw, 'www');
  assert.equal(keysOf('WWW').collapsed, 'w');
});
