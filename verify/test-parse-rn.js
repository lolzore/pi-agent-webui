// Parse check for the React Native sources.
//
// `node --check` is useless on these files and worse than useless: it reported
// exit 0 for a file containing JSX and an unclosed memo( wrapper, because a
// .js file that fails to parse as CommonJS is retried as an ES module and the
// error is swallowed. A syntax check that cannot fail is not a check.
//
// This uses the project's own @babel/parser with JSX and the Flow/class
// properties the RN sources use, so a real syntax error fails the run.
//
// Usage: node test-parse-rn.js <file> [...files]

const fs = require('fs');
const path = require('path');

/* Where @babel/parser comes from.
 *
 * Normally the desktop app's own node_modules, which is where it is installed
 * for the app. PI_RN_MODULES points somewhere else when it is not - the CI
 * installs only the four packages these two checks need rather than the whole
 * React Native tree, and says where it put them. */
const NM = process.env.PI_RN_MODULES || path.join(__dirname, '..', 'pi-desktop', 'node_modules');

let parser;
try {
  parser = require(path.join(NM, '@babel', 'parser'));
} catch {
  // A skip, not a failure: these checks protect a part of the app this suite can
  // otherwise verify nothing about, but the absence of their tooling is not a
  // defect in the code under test. Printed as SKIP so it is visibly not a pass.
  console.log('  SKIP @babel/parser is not installed (looked in ' + NM + ')');
  process.exit(77);
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: test-parse-rn.js <file> [...files]');
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  try {
    parser.parse(src, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      plugins: ['jsx', 'classProperties', 'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator'],
    });
  } catch (e) {
    bad++;
    const line = e.loc ? e.loc.line : '?';
    console.error(`FAIL: ${f}:${line}: ${e.message}`);
  }
}
process.exit(bad ? 1 : 0);
