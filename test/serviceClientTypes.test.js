const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const ts = require('typescript');

test('the shipped client declarations enforce request arguments and wire result types', () => {
  const program = ts.createProgram([path.join(__dirname, 'types/serviceClient.ts')], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    skipLibCheck: true,
    types: ['node']
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n'
  }));
});
