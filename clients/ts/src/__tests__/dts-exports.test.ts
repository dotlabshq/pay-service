import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * A consumer sees the .d.ts, not the sources. A type named in an exported signature that the package does not export
 * cannot be named by the consumer (it had to be re-declared, as `AddressPatch` was). For every entry's declaration
 * file: whatever the exported declarations reference, in the same file, must itself be exported.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dist = join(root, 'dist')

beforeAll(() => { execSync('npx tsup', { cwd: root, stdio: 'ignore' }) }, 180_000)

function unexportedButReferenced(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true)
  const declared = new Map<string, ts.Node>()
  const exported = new Set<string>()
  const hasExport = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      if (!st.moduleSpecifier) for (const e of st.exportClause.elements) exported.add((e.propertyName ?? e.name).text)
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isEnumDeclaration(st)) {
      if (st.name) { declared.set(st.name.text, st); if (hasExport(st)) exported.add(st.name.text) }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) { declared.set(d.name.text, st); if (hasExport(st)) exported.add(d.name.text) }
    }
  }
  // names used by a declaration (types and `typeof x`), ignoring its own type parameters
  const refs = (node: ts.Node): string[] => {
    const out: string[] = []
    const visit = (n: ts.Node) => {
      if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) out.push(n.typeName.text)
      if (ts.isExpressionWithTypeArguments(n) && ts.isIdentifier(n.expression)) out.push(n.expression.text)
      if (ts.isTypeQueryNode(n) && ts.isIdentifier(n.exprName)) out.push(n.exprName.text)
      ts.forEachChild(n, visit)
    }
    visit(node)
    return out
  }
  const bad = new Set<string>()
  const seen = new Set<string>()
  const queue = [...exported]
  while (queue.length) {
    const name = queue.pop()!
    if (seen.has(name)) continue
    seen.add(name)
    const node = declared.get(name)
    if (!node) continue
    for (const r of refs(node)) {
      if (!declared.has(r)) continue // a global, a type parameter, or imported from another package
      if (!exported.has(r)) bad.add(r)
      queue.push(r)
    }
  }
  return [...bad].sort()
}

describe('the declaration files', () => {
  it('every entry exports every type its exported signatures name', () => {
    const files = readdirSync(dist).filter((f) => f.endsWith('.d.ts'))
    expect(files.length).toBeGreaterThan(3)
    const report: Record<string, string[]> = {}
    for (const f of files) { const bad = unexportedButReferenced(join(dist, f)); if (bad.length) report[f] = bad }
    expect(report).toEqual({})
  })

  it('the charge input and the payment record are exported, with both spellings', () => {
    const d = readFileSync(join(dist, 'client.d.ts'), 'utf8')
    expect(d).toMatch(/export \{[^}]*type \bChargeFields\b/)
    expect(d).toMatch(/export \{[^}]*type \bChargeFieldsDeprecated\b/)
    expect(d).toMatch(/export \{[^}]*type \bPaymentFields\b/)
    expect(d).toMatch(/export \{[^}]*type \bPaymentAliases\b/)
    expect(existsSync(join(dist, 'mcp.d.ts'))).toBe(true)
  })
})
