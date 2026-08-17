const HEURISTIC_INSTRUCTION_PATTERNS = [
  /\b(?:jailbreak|prompt\s+injection|system\s+prompt)\b/i,
  /(?:越狱|提示词注入|系统提示词)/,
] as const;

const QUOTED_FRAGMENT_PATTERN = /"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/gu;
const NEGATED_COMMAND_PATTERN =
  /\b(?:do\s+not|don't|never|must\s+not)\s+(?:please\s+)?(?:ignore|disregard|override|disable|bypass)\b/gi;
const CONJOINED_NEGATED_COMMAND_PATTERN =
  /\b(?:nor|or)\s+(?:please\s+)?(?:ignore|disregard|override|disable|bypass)\b/gi;
const NEGATED_COMMAND_ZH_PATTERN = /(?:不要|不得|禁止|请勿)\s*(?:忽略|无视|绕过|禁用)/g;
const CONJOINED_NEGATED_COMMAND_ZH_PATTERN =
  /(?:也不要|也不得|也请勿|或者|或)\s*(?:忽略|无视|绕过|禁用)/g;
const NEGATION_SCOPE_SEPARATOR_PATTERN =
  /([,:，：]|\b(?:but|however|then|yet)\b|但是|但|然而|然后)/giu;
const CLAUSE_SEPARATOR_PATTERN = /[.!?;。！？；]+/u;
const PROMPT_CONTROL_ACTION_PATTERN = /\b(?:ignore|disregard|override)\b/i;
const PROMPT_CONTROL_SOURCE_PATTERN = /\b(?:developer|previous|system)\b/i;
const PROMPT_CONTROL_OBJECT_PATTERN = /\b(?:instruction|message|prompt)s?\b/i;
const SECURITY_CONTROL_ACTION_PATTERN = /\b(?:bypass|disable)\b/i;
const SECURITY_CONTROL_SCOPE_PATTERN = /\b(?:permission|security|tool)s?\b/i;
const SECURITY_CONTROL_OBJECT_PATTERN = /\b(?:checks?|guards?|polic(?:y|ies))\b/i;
const PROMPT_CONTROL_ACTION_ZH_PATTERN = /忽略|无视/;
const PROMPT_CONTROL_SOURCE_ZH_PATTERN = /之前|开发者|系统/;
const PROMPT_CONTROL_OBJECT_ZH_PATTERN = /指令|消息|提示/;
const SECURITY_CONTROL_ACTION_ZH_PATTERN = /禁用|绕过/;
const SECURITY_CONTROL_SCOPE_ZH_PATTERN = /安全|工具|权限/;
const SECURITY_CONTROL_OBJECT_ZH_PATTERN = /检查|策略|防护/;

const maskNegatedActionGroups = (clause: string) =>
  clause
    .split(NEGATION_SCOPE_SEPARATOR_PATTERN)
    .map((segment) => {
      const english = segment.replaceAll(NEGATED_COMMAND_PATTERN, 'safe-command');
      const englishGroup =
        english === segment
          ? english
          : english.replaceAll(CONJOINED_NEGATED_COMMAND_PATTERN, ' safe-command');
      const chinese = englishGroup.replaceAll(NEGATED_COMMAND_ZH_PATTERN, '安全提示');
      return chinese === englishGroup
        ? chinese
        : chinese.replaceAll(CONJOINED_NEGATED_COMMAND_ZH_PATTERN, '安全提示');
    })
    .join('');

export const classifyDangerousInstructions = (content: string) => {
  let error = false;
  let warning = false;
  for (const rawLine of content
    .normalize('NFKC')
    .replaceAll(/\p{Cf}/gu, '')
    .replaceAll(/[‘’‛ʼꞌ]/gu, "'")
    .split(/\r?\n/)) {
    const line = rawLine.replaceAll(QUOTED_FRAGMENT_PATTERN, '').trim();
    if (!line) continue;
    for (const rawClause of line.split(CLAUSE_SEPARATOR_PATTERN)) {
      const clause = maskNegatedActionGroups(rawClause);
      const promptControl =
        (PROMPT_CONTROL_ACTION_PATTERN.test(clause) &&
          PROMPT_CONTROL_SOURCE_PATTERN.test(clause) &&
          PROMPT_CONTROL_OBJECT_PATTERN.test(clause)) ||
        (PROMPT_CONTROL_ACTION_ZH_PATTERN.test(clause) &&
          PROMPT_CONTROL_SOURCE_ZH_PATTERN.test(clause) &&
          PROMPT_CONTROL_OBJECT_ZH_PATTERN.test(clause));
      const securityControl =
        (SECURITY_CONTROL_ACTION_PATTERN.test(clause) &&
          SECURITY_CONTROL_SCOPE_PATTERN.test(clause) &&
          SECURITY_CONTROL_OBJECT_PATTERN.test(clause)) ||
        (SECURITY_CONTROL_ACTION_ZH_PATTERN.test(clause) &&
          SECURITY_CONTROL_SCOPE_ZH_PATTERN.test(clause) &&
          SECURITY_CONTROL_OBJECT_ZH_PATTERN.test(clause));
      if (promptControl || securityControl) error = true;
      else if (HEURISTIC_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(clause))) {
        warning = true;
      }
    }
  }
  return { error, warning };
};
