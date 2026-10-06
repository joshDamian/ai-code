// How an approved draft will run: the pipeline (plan, approve, implement, review) or
// a session (one conversation in its own worktree, started on approval). Shared by
// the draft card under a conversation and the project page's queue, which are the
// same decision in two places.
import { html } from '../lib.mjs';

const ENGINE_NOTE = {
  pipeline: 'Plans first for you to approve, then implements and reviews.',
  session: 'Starts one conversation in its own worktree now, with tests after each turn.',
};
export function EnginePick({ value, onChange, disabled }) {
  return html`
    <div class="engine-pick">
      <span class="muted">Run as</span>
      <div class="seg" role="radiogroup" aria-label="Run as">
        ${['pipeline', 'session'].map(
          (e) => html`<button type="button" key=${e} role="radio" aria-checked=${value === e ? 'true' : 'false'} class="seg-btn ${value === e ? 'active' : ''}" disabled=${disabled} onClick=${() => onChange(e)}>${e === 'pipeline' ? 'Pipeline' : 'Session'}</button>`
        )}
      </div>
      <span class="muted engine-note">${ENGINE_NOTE[value]}</span>
    </div>
  `;
}

