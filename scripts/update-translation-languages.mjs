// Reproducible catalog import. No runtime network request is made by the UI.
import fs from 'node:fs/promises'
const registryUrl = 'https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry'
const cldrUrl = 'https://raw.githubusercontent.com/unicode-org/cldr-json/48.1.0/cldr-json/cldr-core/availableLocales.json'
const defaultContentUrl = 'https://raw.githubusercontent.com/unicode-org/cldr-json/48.1.0/cldr-json/cldr-core/defaultContent.json'
async function get(url) { const response = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error(`${response.status} ${url}`); return response }
const registry = await (await get(registryUrl)).text()
const languages = registry.split('%%').slice(1).flatMap(block => {
  const fields = Object.create(null)
  for (const line of block.trim().split('\n')) { const split = line.indexOf(': '); if (split >= 0) (fields[line.slice(0, split)] ??= []).push(line.slice(split + 2)) }
  return fields.Type?.[0] === 'language' && !fields.Deprecated && fields.Subtag?.[0] && !fields.Subtag[0].includes('..') ? [[fields.Subtag[0], fields.Description[0]]] : []
})
const cldr = await (await get(cldrUrl)).json()
const defaults = await (await get(defaultContentUrl)).json()
const data = { registryDate: registry.split('\n')[0].split(': ')[1], languages, locales: [...new Set([...cldr.availableLocales.full, ...defaults.defaultContent])].sort() }
if (languages.length < 8000 || data.locales.length < 700) throw new Error('Unexpected catalog coverage')
await fs.writeFile(new URL('../packages/web/src/lib/translation-languages.json', import.meta.url), JSON.stringify(data) + '\n')
console.log(JSON.stringify({ registryDate: data.registryDate, languages: languages.length, locales: data.locales.length }))
