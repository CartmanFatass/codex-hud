/** Extract a task summary without surfacing messages injected into user-role history. */
export function taskText(raw:unknown):string|undefined {
  if (typeof raw !== 'string') return undefined;
  let text=raw.trim();
  const metadata = 'recommended_plugins?|environment_context|skills_instructions|user_instructions|subagent_notification|turn_aborted|permissions_instructions';
  text=text.replace(new RegExp(`<(${metadata})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`,'gi'),'');
  // An incomplete metadata block is still metadata, not a task.
  text=text.replace(new RegExp(`<(?:${metadata})(?:\\s[^>]*)?>[\\s\\S]*$`,'gi'),'').trim();
  if (!text || /^# AGENTS\.md instructions for\b/.test(text) ||
      /^Here is a list of plugins that are available but not installed\b/.test(text)) return undefined;
  return text.replace(/\s+/g,' ').slice(0,500);
}
