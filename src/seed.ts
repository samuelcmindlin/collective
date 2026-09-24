import { nowIso, Store } from './store.js';

export function seed(store: Store) {
  if (store.get('settings', 'settings')) return;
  store.transaction(() => {
    store.put('settings', { id: 'settings', paused: true, timezone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, maxConcurrent: 2, maxTurnsPerRun: 8, maxRunsPerDay: 40, maxRunSeconds: 180, quotaStopPercent: 20, quotaMaxAgeMinutes: 10, model: 'sonnet', theme: 'office', maxAgents: 6, maxConversationDepth: 3, demoStep: 0 });
    for (const [roomId, name, purpose, icon] of [
      ['commons', 'Commons', 'Mission, announcements, and shared conversation', '◈'],
      ['studio', 'Studio', 'Ideas, design, and focused collaboration', '✳'],
      ['lab', 'Lab', 'Research, experiments, and independent review', '⌬'],
      ['workshop', 'Workshop', 'Build, test, and publish artifacts', '⌘'],
      ['library', 'Library', 'Shared knowledge and recorded decisions', '▤'],
    ]) store.put('rooms', { id: roomId!, name: name!, purpose: purpose!, icon: icon!, createdAt: nowIso() });
    const agents = [
      { id: 'nova', name: 'Nova', role: 'Coordinator', color: '#b9c798', avatar: 'N', bio: 'Turns a broad mission into useful experiments. Connects people and work, keeps decisions grounded in evidence.' },
      { id: 'atlas', name: 'Atlas', role: 'Researcher', color: '#91b5c8', avatar: 'A', bio: 'Follows sources, tests assumptions, and records what is known—and what still needs an answer.' },
      { id: 'ember', name: 'Ember', role: 'Builder', color: '#d8a681', avatar: 'E', bio: 'Makes things tangible. Builds small, tests early, and leaves artifacts that others can inspect.' },
      { id: 'iris', name: 'Iris', role: 'Reviewer', color: '#bca6d3', avatar: 'I', bio: 'Checks evidence against the mission. Looks for missing cases and offers concrete improvements.' },
    ];
    for (const agent of agents) store.put('agents', { ...agent, roomId: 'commons', status: 'idle', completed: 0, createdAt: nowIso() });
    store.put('missions', { id: 'mission_first', title: 'Create a game', brief: 'Choose a promising direction and create a small playable game. Collaborate, test your assumptions, and produce something others can try. Work within the granted permissions and budget.', criteria: ['A playable artifact exists', 'Another agent reviews the game against its stated rules', 'Record the design decisions and remaining improvements'], status: 'draft', revision: 1, createdAt: nowIso() });
    store.event('collective.created', 'system', undefined, { agents: 4, rooms: 5 });
  });
}
