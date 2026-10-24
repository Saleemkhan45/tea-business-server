import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
const envPath = fileURLToPath(new URL('../.env', import.meta.url))

export function inspectEnv(source) {
  const lines = source.split(/\r\n|\n|\r/)
  if (lines.at(-1) === '') lines.pop()
  const parsed = dotenv.parse(source)
  const mongoLines = []
  const inventory = lines.map((line, index) => {
    const clean = line.replace(/\uFEFF/g, '').trimStart()
    const commented = clean.startsWith('#')
    const content = commented ? clean.replace(/^#\s*/, '') : clean
    const match = content.match(assignment)
    if (/^(?:export\s+)?MONGODB_URI(?:\s|=|$)/.test(content)) {
      mongoLines.push({ index, commented, match })
    }
    const label = commented ? 'commented out' : match ? match[1] : 'invalid line'
    return `${index + 1}: ${label}`
  })

  const active = mongoLines.filter(line => !line.commented)
  const mongo = active[0] ?? mongoLines[0]
  let value = mongo?.match?.[2] ?? ''
  let lastIndex = mongo?.index ?? -1
  let quotesBalanced = true
  const quote = value.match(/^["'`]/)?.[0]
  const hasClosingQuote = () => new RegExp(`${quote}\\s*(?:#.*)?$`).test(value.slice(1))

  if (quote) {
    while (!hasClosingQuote() && lastIndex + 1 < lines.length) {
      const next = lines[lastIndex + 1]
      if (assignment.test(next) || /^\s*#/.test(next)) break
      value += `\n${next}`
      lastIndex += 1
    }
    quotesBalanced = hasClosingQuote()
  } else if (mongo) {
    quotesBalanced = !/["'`]\s*(?:#.*)?$/.test(value)
    // Unquoted dotenv values stop at a newline, even when the URI continues below.
    while (lastIndex + 1 < lines.length) {
      const next = lines[lastIndex + 1]
      if (assignment.test(next) || /^\s*#/.test(next)
        || !/^\s*(?:mongodb(?:\+srv)?:\/\/|[/?&@]|[^\s#]+[:/,?@&])/i.test(next)) break
      value += `\n${next}`
      lastIndex += 1
    }
  }

  const exists = Object.hasOwn(parsed, 'MONGODB_URI')
  const parsedValue = parsed.MONGODB_URI ?? ''
  const scheme = (parsedValue || value).trim().replace(/^["'`]/, '')
    .match(/^mongodb(?:\+srv)?:\/\//i)?.[0].toLowerCase() ?? 'not detected'
  const multiline = lastIndex > (mongo?.index ?? -1) || /[\r\n]/.test(parsedValue)
  const bom = source.includes('\uFEFF')
  const trailingWhitespace = mongo
    ? lines.slice(mongo.index, lastIndex + 1).some(line => /[\t ]+$/.test(line))
    : false
  const valid = exists && Boolean(parsedValue.trim()) && active.length === 1
    && Boolean(mongo?.match) && quotesBalanced && !multiline && scheme !== 'not detected'
    && !/\s/.test(parsedValue.trim())

  return { inventory, exists, commentedOut: mongoLines.some(line => line.commented),
    quotesBalanced, multiline, bom, trailingWhitespace, scheme, valid, assignments: active.length }
}

export function printEnvReport(report) {
  const yesNo = value => value ? 'yes' : 'no'
  for (const line of report.inventory) console.log(line)
  console.log(`MONGODB_URI exists (dotenv): ${yesNo(report.exists)}`)
  console.log(`MONGODB_URI commented out: ${yesNo(report.commentedOut)}`)
  console.log(`MONGODB_URI quotes balanced: ${yesNo(report.quotesBalanced)}`)
  console.log(`MONGODB_URI spans multiple lines: ${yesNo(report.multiline)}`)
  console.log(`BOM present: ${yesNo(report.bom)}`)
  console.log(`MONGODB_URI trailing whitespace: ${yesNo(report.trailingWhitespace)}`)
  console.log(`MONGODB_URI active assignments: ${report.assignments}`)
  console.log(`MONGODB_URI scheme: ${report.scheme}`)
  console.log(`MONGODB_URI structurally valid: ${yesNo(report.valid)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = inspectEnv(await readFile(envPath, 'utf8'))
    printEnvReport(report)
    if (!report.valid) process.exitCode = 1
  } catch {
    console.error('Cannot read server/.env. Check that the file exists and is readable.')
    process.exitCode = 1
  }
}
