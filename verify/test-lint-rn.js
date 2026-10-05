// Lint the React Native sources for the errors a parser cannot see.
//
// The parse check catches syntax. It cannot catch an identifier that is used but
// never defined — which is exactly what a half-finished edit leaves behind, and
// what blows up at runtime on a device rather than at build time. The bug this
// was added for was `escapeHtml(...)` called in Markdown.js after the helper it
// called had been deleted: valid syntax, a ReferenceError the moment a message
// with plain text rendered.
//
// Only the rules that catch real breakage are enabled. Style and formatting are
// eslint's default noise here and would bury the signal.
//
// Usage: node test-lint-rn.js <file> [...files]

const fs = require('fs');
const path = require('path');

/* Where eslint and the babel bits come from. See test-parse-rn.js: normally the
 * app's own node_modules, or PI_RN_MODULES when the CI installed just these
 * packages instead of the whole React Native tree. */
const NM = process.env.PI_RN_MODULES || path.join(__dirname, '..', 'pi-desktop', 'node_modules');

let ESLint;
try {
  ({ ESLint } = require(path.join(NM, 'eslint')));
} catch {
  console.log('  SKIP eslint is not installed (looked in ' + NM + ')');
  process.exit(77);
}

(async () => {
  const files = process.argv.slice(2).filter((f) => fs.existsSync(f));
  if (!files.length) {
    console.error('usage: test-lint-rn.js <file> [...files]');
    process.exit(2);
  }

  const eslint = new ESLint({
    cwd: path.join(__dirname, '..', 'pi-desktop'),
    useEslintrc: false,          // the project's own config is style-heavy and
    resolvePluginsRelativeTo: NM,// would drown the two rules that matter here
    baseConfig: {
      parser: path.join(NM, '@babel', 'eslint-parser'),
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        requireConfigFile: false,
        ecmaFeatures: { jsx: true },
        // The plugin has to be named by path: babel resolves a bare "jsx" as the
        // npm package babel-plugin-jsx, which is not installed, and every file
        // with JSX becomes a parse error instead.
        babelOptions: { plugins: [path.join(NM, '@babel', 'plugin-syntax-jsx')] },
      },
      env: { es2022: true, browser: true, node: true },
      plugins: ['react', 'react-hooks'],
      settings: { react: { version: 'detect' } },
      rules: {
        'no-undef': 'error',
        'no-dupe-keys': 'error',
        'no-dupe-args': 'error',
        'no-unreachable': 'error',
        'no-const-assign': 'error',
        'no-func-assign': 'error',
        'no-self-assign': 'error',
        'no-duplicate-case': 'error',
        'no-unsafe-finally': 'error',
        'getter-return': 'error',
        'no-sparse-arrays': 'error',
        // hooks called in a loop or a callback are a real crash class in RN
        'react-hooks/rules-of-hooks': 'error',
      },
    },
  });

  // eslint resolves the patterns against its own cwd, which is pi-desktop/, so
  // the paths have to be absolute or it reports "no files matching" for files
  // that plainly exist.
  const abs = files.map((f) => path.resolve(f));
  const results = await eslint.lintFiles(abs);
  const problems = results.flatMap((r) => r.messages.map((m) => ({
    file: path.relative(process.cwd(), r.filePath),
    line: m.line,
    rule: m.ruleId,
    msg: m.message,
  })));

  for (const p of problems) {
    console.error(`FAIL: ${p.file}:${p.line}: ${p.msg} (${p.rule})`);
  }
  if (problems.length) {
    console.error(`${problems.length} problem(s) in ${results.length} file(s)`);
    process.exit(1);
  }
  console.log(`${results.length}`);
})().catch((e) => { console.error('FAIL: ' + (e.stack || e.message)); process.exit(1); });
