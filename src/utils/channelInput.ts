/**
 * پشتیبانی می‌کنه از:
 *   smozic
 *   @smozic
 *   t.me/smozic
 *   https://t.me/smozic
 *   https://t.me/smozic/
 *   https://t.me/+Pv5XTmrAWiehO_0a   → +Pv5XTmrAWiehO_0a
 *   https://t.me/joinchat/xxxxx      → +xxxxx
 */
export function normalizeChannelInput(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "";

  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^(www\.)?(t\.me|telegram\.me)\//i, "");
  s = s.split("?")[0].split("#")[0];
  s = s.replace(/\/+$/, "").trim();

  const joinchatMatch = s.match(/^joinchat\/([\w-]+)$/i);
  if (joinchatMatch) return `+${joinchatMatch[1]}`;

  if (/^\+[\w-]+$/.test(s)) return s;

  return s.replace(/^@/, "");
}