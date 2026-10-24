/**
 * The household profile: who the agent is helping. Collected once at sign-up; here a fixed file,
 * data/profile.json. Loaded once and turned into a few plain lines that go into every prompt's system
 * message (see SYSTEM_PROMPT in agent.ts). It is always present, not searched.
 */
import { readFileSync } from "node:fs";

/** One person in the household. Empty lists mean "nothing to note". */
interface Person {
  name: string;
  ageGroup: string; // e.g. "older adult (72)", "child (8)"
  languages: string[];
  conditions: string[]; // only ones that matter in an emergency (diabetes, asthma, pregnancy...)
  medications: { name: string; refrigerated: boolean }[];
  devices: string[]; // power-dependent medical devices (oxygen concentrator, CPAP...)
  access: string[]; // mobility, hearing or vision needs
}

/** The person to call for help. Also shown, read-only, on the app's screen (see the companion's setup.ts). */
export interface SupportContact {
  name: string;
  relation: string; // e.g. "aunt"
  city: string;
  phone: string;
}

/** The shape of data/profile.json. */
export interface Profile {
  householdSize: number;
  location: { city: string; county: string; state: string; zip: string };
  home: { type: string; nearbyHazards: string[] };
  people: Person[];
  animals: { name: string; type: string; notes?: string }[];
  plan: { meetingPoints: string[]; supportContact: SupportContact; transport: string };
}

export const PROFILE: Profile = JSON.parse(readFileSync(new URL("../data/profile.json", import.meta.url), "utf8"));

/** One line per person, e.g. "Maria: older adult (72); speaks Spanish, English; type 2 diabetes; insulin (must stay refrigerated)". */
function personLine(p: Person): string {
  const parts = [
    p.ageGroup,
    `speaks ${p.languages.join(", ")}`,
    ...p.conditions,
    ...p.medications.map((m) => (m.refrigerated ? `${m.name} (must stay refrigerated)` : m.name)),
    ...p.devices.map((d) => `uses ${d} (needs power)`),
    ...p.access,
  ];
  return `- ${p.name}: ${parts.join("; ")}`;
}

/** ", plus 1 dog" / ", plus 2 animals" / "" */
function pets(p: Profile): string {
  if (p.animals.length === 0) return "";
  return p.animals.length === 1 ? `, plus 1 ${p.animals[0].type}` : `, plus ${p.animals.length} animals`;
}

/** "Aunt Rosa (aunt) in Sacramento, 555-0142" */
export function contactLine(c: SupportContact): string {
  return `${c.name} (${c.relation}) in ${c.city}, ${c.phone}`;
}

/** The profile as the lines the model reads. */
export function profileText(p: Profile = PROFILE): string {
  const animals = p.animals.map((a) => `${a.name}, ${a.type}${a.notes ? ` (${a.notes})` : ""}`);
  return [
    "Household profile (from the user's sign-up):",
    `- Household size: ${p.householdSize} ${p.householdSize === 1 ? "person" : "people"}${pets(p)}`,
    `- Location: ${p.location.city}, ${p.location.county}, ${p.location.state} ${p.location.zip}`,
    `- Home: ${p.home.type}${p.home.nearbyHazards.length ? `. Nearby hazards: ${p.home.nearbyHazards.join("; ")}` : ""}`,
    ...p.people.map(personLine),
    ...(animals.length ? [`- Animals: ${animals.join("; ")}`] : []),
    `- Meeting points: ${p.plan.meetingPoints.join("; ")}`,
    `- Support contact (out of area): ${contactLine(p.plan.supportContact)}`,
    `- Transport: ${p.plan.transport}`,
  ].join("\n");
}
