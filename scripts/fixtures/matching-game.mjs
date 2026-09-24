// Controlled rehearsal candidate. The host owns the oracle in the rehearsal script.
import { readFileSync } from 'node:fs';
const { actions } = JSON.parse(readFileSync(0, 'utf8'));
const deck = ['a', 'b', 'a', 'b'];
let selected = [], matched = [], moves = 0;
for (const action of actions) {
  if (action === 'restart') { selected = []; matched = []; moves = 0; continue; }
  if (!Number.isInteger(action) || action < 0 || action >= deck.length || matched.includes(action) || selected.includes(action)) continue;
  if (selected.length === 2) selected = [];
  selected.push(action);
  if (selected.length === 2) {
    moves++;
    if (deck[selected[0]] === deck[selected[1]]) { matched.push(...selected); selected = []; }
  }
}
console.log(JSON.stringify({ selected, matched: matched.sort((a, b) => a - b), moves, complete: matched.length === deck.length }));
