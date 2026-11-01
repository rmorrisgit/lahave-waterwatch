// Execute the vendored leaflet.js in a minimal window shim to confirm it
// defines a working L with a map() factory. This isolates "is the file good?"
// from "is the browser environment clobbering L?".
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, 'static', 'vendor', 'leaflet.js'), 'utf8');

const navigator = { userAgent: 'node', platform: 'node' };
const documentStub = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {} } }),
  documentElement: { style: {} },
  createElementNS: () => ({ style: {} }),
  addEventListener() {},
};
const sandbox = {};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.navigator = navigator;
sandbox.document = documentStub;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;

try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'leaflet.js' });
  const L = sandbox.L;
  console.log('typeof L        :', typeof L);
  console.log('L.version       :', L && L.version);
  console.log('typeof L.map    :', L && typeof L.map);
  console.log('typeof L.tileLayer:', L && typeof L.tileLayer);
  console.log(L && typeof L.map === 'function' ? 'FILE IS GOOD ✅' : 'FILE IS BAD ❌');
} catch (e) {
  console.log('leaflet.js threw during execution:', e.message);
  console.log('(A DOM API the shim lacks can cause this in Node but not a browser.)');
}
