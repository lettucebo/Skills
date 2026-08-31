import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDirectory = path.resolve(__dirname, '..', '..', 'test');
const childProcessModules = new Set([
  'child_process',
  'node:child_process',
  'node:child_process/promises',
]);
const launcherNames = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);

function staticStrings(node: ts.Node): string[] {
  const values: string[] = [];
  function visit(current: ts.Node): void {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      values.push(current.text);
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return values;
}

function launchesSiteBuild(source: string): boolean {
  const sourceFile = ts.createSourceFile(
    'site-test.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const directLaunchers = new Set<string>();
  const namespaces = new Set<string>();

  function registerBinding(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      namespaces.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
      const importedName =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
      if (launcherNames.has(importedName)) {
        directLaunchers.add(element.name.text);
      }
    }
  }

  function loadedChildProcessModule(
    initializer: ts.Expression | undefined,
  ): string | null {
    let expression = initializer;
    while (expression && ts.isAwaitExpression(expression)) {
      expression = expression.expression;
    }
    if (!expression || !ts.isCallExpression(expression)) return null;

    const isDynamicImport =
      expression.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire =
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'require';
    const [moduleArgument] = expression.arguments;
    if (
      (!isDynamicImport && !isRequire) ||
      !moduleArgument ||
      !ts.isStringLiteral(moduleArgument) ||
      !childProcessModules.has(moduleArgument.text)
    ) {
      return null;
    }
    return moduleArgument.text;
  }

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !childProcessModules.has(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    if (statement.importClause?.name) {
      namespaces.add(statement.importClause.name.text);
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (launcherNames.has(importedName)) {
          directLaunchers.add(element.name.text);
        }
      }
    }

  }

  function collectLoadedBindings(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      if (loadedChildProcessModule(node.initializer)) {
        registerBinding(node.name);
      }
    }
    ts.forEachChild(node, collectLoadedBindings);
  }
  collectLoadedBindings(sourceFile);

  let found = false;
  function visit(node: ts.Node): void {
    if (found || !ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const expression = node.expression;
    const isDirect =
      ts.isIdentifier(expression) && directLaunchers.has(expression.text);
    const isNamespaced =
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text) &&
      launcherNames.has(expression.name.text);
    if (!isDirect && !isNamespaced) {
      ts.forEachChild(node, visit);
      return;
    }

    const command = staticStrings(node).join(' ').toLowerCase();
    found =
      /\bnpm(?:\.cmd)?\b(?:\s+\S+)*\s+run\s+build\b/.test(command) ||
      /\bnpx\b(?:\s+\S+)*\s+astro\s+build\b/.test(command) ||
      /\bastro\s+build\b/.test(command);
    if (!found) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

test('build-launch detection covers the child_process command surface', () => {
  const launchers = [
    `import { execSync } from 'node:child_process'; execSync('npm run build')`,
    `import { exec } from 'node:child_process'; await exec('npm run build')`,
    `import { spawn } from 'node:child_process'; spawn('npm', ['run', 'build'])`,
    `import { execFileSync } from 'node:child_process';
     execFileSync('npm', ['--prefix', 'site', 'run', 'build'])`,
    `import { execFileSync } from 'node:child_process';
     execFileSync('npx', ['astro', 'build'])`,
    'import * as cp from "node:child_process"; cp.execFileSync(`npm`, [`run`, `build`])',
    `import { execSync } from 'child_process'; execSync('npm run build')`,
    `import cp from 'node:child_process'; cp.execSync('npm run build')`,
    `const { execSync } = await import('node:child_process');
     execSync('npm run build')`,
    `const cp = require('child_process'); cp.spawnSync('npx', ['astro', 'build'])`,
  ];

  for (const source of launchers) {
    assert.equal(launchesSiteBuild(source), true, source);
  }
});

test('site unit tests consume prebuilt dist and never launch a site build', async () => {
  const testFiles = (await readdir(testDirectory))
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
  const offenders = [];

  for (const name of testFiles) {
    const source = await readFile(path.join(testDirectory, name), 'utf8');
    if (launchesSiteBuild(source)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, []);
});

test('dist tests skip only when the completed-build marker is absent', async () => {
  const upstreamHistory = await readFile(
    path.join(testDirectory, 'upstream-history-render.test.ts'),
    'utf8',
  );
  const sourcePage = await readFile(
    path.join(testDirectory, 'source-page-render.test.ts'),
    'utf8',
  );

  assert.match(upstreamHistory, /const distExists = fs\.existsSync\(pagefindEntry\)/);
  assert.doesNotMatch(upstreamHistory, /mappedOutputExists|restrictedOutputExists/);
  assert.match(sourcePage, /const distExists = fs\.existsSync\(pagefindEntry\)/);
});
