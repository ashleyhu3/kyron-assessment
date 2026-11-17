import { dateKey, parseDate } from '../contracts/calendar.ts';

// Relative language proposes a date; it never authorizes an appointment change.
// The agent must read the proposed calendar date back to the caller.
export function proposedDate(text: string, reference: string | undefined, zone: string): string | undefined {
  const absolute = parseDate(text);
  if (absolute) return absolute;
  if (!reference || !Number.isFinite(Date.parse(reference))) return;
  const today = new Date(`${dateKey(reference, zone)}T12:00:00Z`);
  let days: number;
  if (/\btomorrow\b/i.test(text)) days = 1;
  else if (/\btoday\b/i.test(text)) days = 0;
  else {
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const mentioned = weekdays.filter(day => new RegExp(`\\b${day}\\b`, 'i').test(text));
    if (mentioned.length !== 1) return;
    days = (weekdays.indexOf(mentioned[0]) - today.getUTCDay() + 7) % 7 || 7;
    // "Next Thursday" is intentionally a proposal, resolved by confirmation.
  }
  today.setUTCDate(today.getUTCDate() + days);
  return today.toISOString().slice(0, 10);
}

export function medicationMatches(description: string, records: any[]): any[] {
  if (/\b(?:not|maybe|might|think|unsure|either)\b|don['’]t|can['’]t remember/i.test(description)) return [];
  const words = description.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return records.filter(record => {
    const label = String(record.label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (` ${words} `.includes(` ${label} `)) return true;
    // Require the recorded name AND strength. Appearance or indication cannot
    // identify a medication, even when there is only one history record.
    const identity = label.match(/^(.+?)\s+(\d+(?: \d+)?)\s+(mg|mcg|g|ml)\b/);
    return !!identity && ` ${words} `.includes(` ${identity[1]} `)
      && ` ${words} `.includes(` ${identity[2]} ${identity[3]} `);
  });
}
