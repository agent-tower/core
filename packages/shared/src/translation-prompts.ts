type Variable = 'target_language' | 'text';
type TemplatePart = string | { variable: Variable };

function parseTemplate(template: string) {
  const parts: TemplatePart[] = [];
  const variables = new Set<Variable>();
  let cursor = 0;
  for (const match of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const literal = template.slice(cursor, match.index);
    const name = match[1].trim();
    if (literal.includes('{{') || literal.includes('}}') || (name !== 'text' && name !== 'target_language')) return null;
    parts.push(literal, { variable: name });
    variables.add(name);
    cursor = match.index + match[0].length;
  }
  const tail = template.slice(cursor);
  if (tail.includes('{{') || tail.includes('}}')) return null;
  parts.push(tail);
  return { parts, variables };
}

/** Validate the role boundary before inserting any values. Source text is always literal. */
export function compileTranslationPrompts(systemPrompt: string, userTemplate: string) {
  const system = parseTemplate(systemPrompt);
  const user = parseTemplate(userTemplate);
  if (!system || !user) return null;
  const hasTarget = system.variables.has('target_language') || user.variables.has('target_language');
  if (!hasTarget || system.variables.has('text') || !user.variables.has('text')) return null;

  return (targetLanguage: string, text: string) => {
    const values = { target_language: targetLanguage, text };
    const render = (parts: TemplatePart[]) => parts.map(part => typeof part === 'string' ? part : values[part.variable]).join('');
    return { system: render(system.parts), user: render(user.parts) };
  };
}
