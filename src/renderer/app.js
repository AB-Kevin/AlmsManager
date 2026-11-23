'use strict';

(function () {
  const api = window.api;
  const S = window.Schedule;

  let state = null;
  let view = 'tasks';
  let caseFilter = 'open';
  let caseQuery = '';
  let detailId = null; // the case whose dialog is open

  // Helpers ---------------------------------------------------------------

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const date = (s) => S.formatDate(s);
  const money = (n) => S.formatMoney(n);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const METHOD = { check: 'Check', writeoff: 'Invoice write-off' };
  const STATE = {
    requested: ['Waiting for a decision', 'tag-outline'],
    active: ['Active', 'tag-green'],
    declined: ['Declined', 'tag-gray'],
    ended: ['Ended', 'tag-gray'],
    closed: ['Closed', 'tag-gray'],
  };

  function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  }

  function dueText(due) {
    const days = daysBetween(due, state.today);
    if (days > 1) return `${days} days overdue`;
    if (days === 1) return '1 day overdue';
    if (days === 0) return 'Due today';
    if (days === -1) return 'Due tomorrow';
    return `In ${-days} days`;
  }

  function toast(message, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
  }

  const caseById = (id) => state.cases.find((c) => c.id === id);

  /** Every task across cases, each with its case. */
  function allTasks() {
    return state.cases
      .filter((c) => c.status === 'approved' || c.status === 'closed')
      .flatMap((c) => c.tasks.map((t) => ({ ...t, case: c })));
  }

  const isOpen = (t) => !t.done && t.case.status === 'approved';

  // Dialogs ---------------------------------------------------------------

  /**
   * Shows a form in a dialog. `onSubmit(values, form)` saves it; a thrown
   * error shows in the dialog, which stays open. Returns the dialog.
   */
  function formDialog({ title, body, submit = 'Save', wide = false, onSubmit, onOpen }) {
    const dlg = document.createElement('dialog');
    dlg.className = `dialog${wide ? ' wide' : ''}`;
    dlg.innerHTML = `
      <form>
        <h2>${esc(title)}</h2>
        <div class="dialog-body">${body}</div>
        <p class="form-error" hidden></p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
          ${submit ? `<button type="submit" class="btn btn-primary">${esc(submit)}</button>` : ''}
        </div>
      </form>`;
    document.body.append(dlg);
    const form = $('form', dlg);
    const error = $('.form-error', dlg);
    $('[data-cancel]', dlg).addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => dlg.remove());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      const button = $('button[type="submit"]', dlg);
      button.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form)), form);
        dlg.close();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    onOpen?.(dlg);
    dlg.showModal();
    return dlg;
  }

  const field = (label, control, hint = '') => `
    <label class="field"><span class="field-label">${esc(label)}</span>${control}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;

  const input = (name, value = '', attrs = '') => `<input name="${name}" value="${esc(value)}" ${attrs}>`;
  const dateInput = (name, value) => `<input type="date" name="${name}" value="${esc(value)}" required>`;
  const textarea = (name, value = '', attrs = '') => `<textarea name="${name}" rows="3" ${attrs}>${esc(value)}</textarea>`;
  const amountInput = (value, required = false) => input('amount', value ?? '', `inputmode="decimal" placeholder="250.00" ${required ? 'required' : ''}`);

  function methodSelect(value) {
    return `<select name="method">${Object.entries(METHOD).map(([k, v]) => `<option value="${k}"${k === value ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
  }

  // Choosing who a case is for, from MemberManager's list.
  function recipientPicker(current) {
    const r = current || { kind: '', id: '', memberId: '', name: '' };
    const hidden = ['kind', 'id', 'memberId', 'name'].map((k) => `<input type="hidden" name="r_${k}" value="${esc(r[k] ?? '')}">`).join('');
    if (!state.members.available) {
      return `${field('Who it is for', input('r_typed', r.name, 'required placeholder="Name of the member or church"'),
        "MemberManager's list can't be reached, so type the name. Edit the case later to link it.")}`;
    }
    return `
      <div class="field picker">
        <span class="field-label">Who it is for</span>
        ${hidden}
        <div class="picked" ${r.name ? '' : 'hidden'}><strong>${esc(r.name)}</strong> <button type="button" class="link" data-repick>Change</button></div>
        <div class="pick" ${r.name ? 'hidden' : ''}>
          <input type="search" data-pick-query placeholder="Search members and churches by name, Member ID or town" autocomplete="off">
          <div class="pick-results" data-pick-results></div>
        </div>
      </div>`;
  }

  function wirePicker(dlg) {
    const query = $('[data-pick-query]', dlg);
    if (!query) return;
    const results = $('[data-pick-results]', dlg);
    const set = (r) => {
      for (const k of ['kind', 'id', 'memberId', 'name']) $(`[name="r_${k}"]`, dlg).value = r[k] ?? '';
      $('.picked strong', dlg).textContent = r.name;
      $('.picked', dlg).hidden = !r.name;
      $('.pick', dlg).hidden = Boolean(r.name);
    };
    let found = [];
    let timer;
    query.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        found = await api.searchMembers(query.value);
        results.innerHTML = found.length
          ? found.map((r, i) => `<button type="button" class="pick-item" data-i="${i}"><strong>${esc(r.name)}</strong><span class="muted small">${esc(r.detail)}</span></button>`).join('')
          : (query.value.trim() ? '<p class="muted small">No one on MemberManager\'s list matches.</p>' : '');
      }, 150);
    });
    results.addEventListener('click', (event) => {
      const item = event.target.closest('.pick-item');
      if (item) set(found[Number(item.dataset.i)]);
    });
    $('[data-repick]', dlg).addEventListener('click', () => {
      set({ kind: '', id: '', memberId: '', name: '' });
      query.value = '';
      results.innerHTML = '';
      query.focus();
    });
  }

  function recipientFrom(values) {
    if (values.r_typed !== undefined) return { kind: 'none', id: null, memberId: '', name: values.r_typed };
    if (!values.r_name) throw new Error('Choose the member or church this case is for.');
    return { kind: values.r_kind, id: values.r_id, memberId: values.r_memberId, name: values.r_name };
  }

  // Actions ---------------------------------------------------------------

  async function afterChange(message) {
    await load();
    if (message) toast(message);
  }

  function newRequest() {
    formDialog({
      title: 'New alms request',
      submit: 'Add request',
      body: `
        ${recipientPicker(null)}
        ${field('What it is for', input('summary', '', 'required maxlength="500" placeholder="Help with monthly living costs"'))}
        <div class="row">
          ${field('Received on', dateInput('requestedOn', state.today))}
          ${field('Requested by', input('requestedBy', '', 'placeholder="Who brought the request (optional)"'))}
        </div>
        <div class="row">
          ${field('How it would be paid', methodSelect('check'))}
          ${field('Amount asked for each quarter', amountInput(null), 'Optional; set when it is approved.')}
        </div>
        ${field('Notes', textarea('notes'))}`,
      onOpen: wirePicker,
      onSubmit: async (v) => {
        const id = await api.createCase({ recipient: recipientFrom(v), summary: v.summary, requestedOn: v.requestedOn, requestedBy: v.requestedBy, method: v.method, amount: v.amount, notes: v.notes });
        await afterChange('Request added.');
        showCase(id);
      },
    });
  }

  function approveCase(c) {
    const from = state.today;
    formDialog({
      title: `Approve: ${c.who.name}`,
      submit: 'Approve',
      body: `
        <div class="row">
          ${field('How it is paid', methodSelect(c.method))}
          ${field('Amount each quarter', amountInput(c.amount, true))}
        </div>
        <div class="row">
          ${field('Starts on', dateInput('approvedFrom', from), 'The first quarter\'s payment is due this day.')}
          ${field('Runs through', dateInput('approvedThrough', S.defaultThrough(from)), `Reviewed ${S.REVIEW_LEAD_DAYS} days before this, to renew it for the next year.`)}
        </div>
        ${field('Approved on', dateInput('decidedOn', state.today))}
        ${field('Note', textarea('note', '', 'placeholder="Who approved it, conditions… (optional)"'))}`,
      onSubmit: async (v) => {
        await api.approve(c.id, v);
        await afterChange('Approved. Its payments and review are on the Tasks page.');
      },
    });
  }

  function declineCase(c) {
    formDialog({
      title: `Decline: ${c.who.name}`,
      submit: 'Decline',
      body: `${field('Declined on', dateInput('decidedOn', state.today))}${field('Why', textarea('note'))}`,
      onSubmit: async (v) => {
        await api.decline(c.id, v);
        await afterChange('Declined.');
      },
    });
  }

  function closeCase(c) {
    const open = c.tasks.filter((t) => !t.done).length;
    formDialog({
      title: `Close: ${c.who.name}`,
      submit: 'Close case',
      body: `
        <p>Closing ends the case now, before ${esc(date(c.approvedThrough))}. ${open ? `Its ${plural(open, 'task')} not yet done ${open === 1 ? 'is' : 'are'} dropped, and stop${open === 1 ? 's' : ''} being reminded.` : ''}</p>
        <p class="muted small">To let it end when the approval runs out, mark its review "Don't renew" instead.</p>
        ${field('Closed on', dateInput('closedOn', state.today))}
        ${field('Why', textarea('note'))}`,
      onSubmit: async (v) => {
        await api.close(c.id, v);
        await afterChange('Closed.');
      },
    });
  }

  function editCase(c) {
    const approved = c.status === 'approved';
    formDialog({
      title: `Edit: ${c.who.name}`,
      body: `
        ${recipientPicker(c.recipient.kind === 'none' && state.members.available ? null : { ...c.recipient, name: c.who.name })}
        ${field('What it is for', input('summary', c.summary, 'required maxlength="500"'))}
        <div class="row">
          ${field('Received on', dateInput('requestedOn', c.requestedOn))}
          ${field('Requested by', input('requestedBy', c.requestedBy))}
        </div>
        <div class="row">
          ${field('How it is paid', methodSelect(c.method))}
          ${field('Amount each quarter', amountInput(c.amount, approved))}
        </div>
        ${approved ? `<div class="row">
          ${field('Starts on', dateInput('approvedFrom', c.approvedFrom))}
          ${field('Runs through', dateInput('approvedThrough', c.approvedThrough))}
        </div>` : ''}
        ${field('Notes', textarea('notes', c.notes))}`,
      onOpen: wirePicker,
      onSubmit: async (v) => {
        const changes = { recipient: recipientFrom(v), summary: v.summary, requestedOn: v.requestedOn, requestedBy: v.requestedBy, method: v.method, amount: v.amount, notes: v.notes };
        if (approved) Object.assign(changes, { approvedFrom: v.approvedFrom, approvedThrough: v.approvedThrough });
        await api.edit(c.id, changes);
        await afterChange('Saved.');
      },
    });
  }

  function markPaid(c, t) {
    const writeoff = c.method === 'writeoff';
    formDialog({
      title: t.label,
      submit: 'Mark done',
      body: `
        <p><strong>${esc(c.who.name)}</strong> · ${esc(money(c.amount))} · due ${esc(date(t.due))}</p>
        ${field(writeoff ? 'Written off on' : 'Sent on', dateInput('on', state.today))}
        ${field(writeoff ? 'Invoice number' : 'Check number', input('note', '', 'placeholder="Optional"'))}`,
      onSubmit: async (v) => {
        await api.markPaid(c.id, t.id, v);
        await afterChange(`${t.label}: done. It's off tomorrow's reminder.`);
      },
    });
  }

  function reviewTask(c, t) {
    formDialog({
      title: `${t.label}: ${c.who.name}`,
      submit: 'Save review',
      body: `
        <p>Approved through <strong>${esc(date(c.approvedThrough))}</strong>: ${esc(money(c.amount))} a quarter, ${esc(METHOD[c.method].toLowerCase())}.</p>
        <fieldset class="choices">
          <label><input type="radio" name="outcome" value="renew" checked> Renew it</label>
          <label><input type="radio" name="outcome" value="end"> Don't renew; it ends ${esc(date(c.approvedThrough))}</label>
        </fieldset>
        <div data-renew>
          <div class="row">
            ${field('How it is paid', methodSelect(c.method))}
            ${field('Amount each quarter', amountInput(c.amount))}
          </div>
          ${field('Renewed through', dateInput('approvedThrough', S.addYears(c.approvedThrough, 1)))}
        </div>
        ${field('Reviewed on', dateInput('on', state.today))}
        ${field('Note', textarea('note', '', 'placeholder="Who reviewed it, what changed… (optional)"'))}`,
      onOpen: (dlg) => {
        const sync = () => {
          const renew = $('[name="outcome"]:checked', dlg).value === 'renew';
          $('[data-renew]', dlg).hidden = !renew;
          for (const el of dlg.querySelectorAll('[data-renew] input, [data-renew] select')) el.disabled = !renew;
        };
        dlg.addEventListener('change', sync);
        sync();
      },
      onSubmit: async (v) => {
        await api.review(c.id, t.id, v);
        await afterChange(v.outcome === 'renew' ? 'Renewed. Next year\'s payments and review are on the Tasks page.' : `Reviewed. It ends ${date(c.approvedThrough)}.`);
      },
    });
  }

  async function undoTask(c, t) {
    if (!window.confirm(`Mark "${t.label}" for ${c.who.name} as not done? It goes back on the reminders.`)) return;
    try {
      await api.undo(c.id, t.id);
      await afterChange('Marked not done.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function doTask(c, t) {
    if (t.kind === 'review') reviewTask(c, t);
    else markPaid(c, t);
  }

  // Case dialog -----------------------------------------------------------

  function caseBody(c) {
    const [stateText, stateTag] = STATE[c.state];
    const actions = [];
    if (c.status === 'requested') {
      actions.push('<button type="button" class="btn btn-primary" data-act="approve">Approve…</button>');
      actions.push('<button type="button" class="btn btn-secondary" data-act="decline">Decline…</button>');
    }
    if (c.status !== 'closed') actions.push('<button type="button" class="btn btn-secondary" data-act="edit">Edit…</button>');
    if (c.status === 'approved') actions.push('<button type="button" class="btn btn-ghost" data-act="close">Close case…</button>');

    const facts = [
      ['For', `${esc(c.who.name)}${c.who.detail ? ` <span class="muted">· ${esc(c.who.detail)}</span>` : ''}${c.who.missing ? ' <span class="tag tag-gray">No longer in MemberManager</span>' : ''}${c.recipient.kind === 'none' ? ' <span class="tag tag-gray">Not linked to MemberManager</span>' : ''}`],
      ['What it is for', esc(c.summary)],
      ['Received', `${esc(date(c.requestedOn))}${c.requestedBy ? ` from ${esc(c.requestedBy)}` : ''}`],
      ['Paid by', esc(METHOD[c.method])],
      ['Each quarter', esc(money(c.amount)) || '<span class="muted">Not set</span>'],
    ];
    if (c.approvedFrom) facts.push(['Approved', `${esc(date(c.approvedFrom))} through ${esc(date(c.approvedThrough))}${c.decidedBy ? ` <span class="muted">· by ${esc(c.decidedBy)}</span>` : ''}`]);
    if (c.status === 'declined') facts.push(['Declined', `${esc(date(c.decidedOn))} <span class="muted">· by ${esc(c.decidedBy)}</span>`]);
    if (c.status === 'closed') facts.push(['Closed', esc(date(c.closedOn))]);
    if (c.notes) facts.push(['Notes', `<span class="pre">${esc(c.notes)}</span>`]);

    const docs = c.documents || [];
    const documents = `
      <div class="sub-head">
        <h3 class="sub">Documents</h3>
        <button type="button" class="btn btn-secondary btn-sm" data-act="addDocs">Add document…</button>
      </div>
      ${docs.length ? `<ul class="docs">${docs.map((d) => `
        <li>
          <button type="button" class="link inline" data-doc-open="${esc(d.id)}">${esc(d.name)}</button>
          <span class="muted small">${esc([fileSize(d.size), `added ${new Date(d.addedAt).toLocaleDateString()} by ${d.addedBy}`].filter(Boolean).join(' · '))}</span>
          <button type="button" class="link" data-doc-remove="${esc(d.id)}">Remove</button>
        </li>`).join('')}</ul>` : '<p class="muted small">No documents yet. Add one, or drop files on this window.</p>'}`;

    const tasks = c.tasks.length ? `
      <h3 class="sub">Tasks</h3>
      <table class="table">
        <thead><tr><th>Due</th><th>Task</th><th>Done</th><th></th></tr></thead>
        <tbody>${c.tasks.map((t) => taskRowForCase(c, t)).join('')}</tbody>
      </table>` : '';

    const history = `
      <h3 class="sub">History</h3>
      <ol class="history">${[...c.history].reverse().map((h) => `<li><span class="muted small">${esc(new Date(h.at).toLocaleString())} · ${esc(h.by)}</span><br>${esc(h.text)}</li>`).join('')}</ol>`;

    return `
      <div class="case-head"><span class="tag ${stateTag}">${esc(stateText)}</span><div class="actions">${actions.join('')}</div></div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
      ${documents}
      ${tasks}
      ${history}`;
  }

  function taskRowForCase(c, t) {
    let action = '';
    if (!t.done && c.status === 'approved') action = `<button type="button" class="btn btn-secondary btn-sm" data-task="${esc(t.id)}">${t.kind === 'review' ? 'Review…' : 'Mark done…'}</button>`;
    else if (t.done && c.status === 'approved' && t.done.outcome !== 'renew') action = `<button type="button" class="link" data-undo="${esc(t.id)}">Undo</button>`;
    const overdue = !t.done && c.status === 'approved' && t.due <= state.today;
    const done = t.done ? `${esc(date(t.done.on))} <span class="muted small">· ${esc(t.done.by)}${t.done.note ? ` · ${esc(t.done.note)}` : ''}${t.done.outcome === 'end' ? ' · not renewed' : ''}${t.done.outcome === 'renew' ? ` · renewed through ${esc(date(t.done.through))}` : ''}</span>` : '';
    return `<tr class="${overdue ? 'due' : ''}"><td>${esc(date(t.due))}</td><td>${esc(t.label)}</td><td>${done}</td><td class="right">${action}</td></tr>`;
  }

  function showCase(id) {
    const c = caseById(id);
    if (!c) return;
    detailId = id;
    const dlg = formDialog({ title: c.who.name, body: caseBody(c), submit: null, wide: true, onSubmit: async () => {} });
    $('[data-cancel]', dlg).textContent = 'Close';
    dlg.addEventListener('close', () => {
      if (detailId === id) detailId = null;
    });
    dlg.addEventListener('click', async (event) => {
      const cur = caseById(id);
      if (!cur) return;
      const act = event.target.closest('[data-act]')?.dataset.act;
      const taskId = event.target.closest('[data-task]')?.dataset.task;
      const undoId = event.target.closest('[data-undo]')?.dataset.undo;
      const openDoc = event.target.closest('[data-doc-open]')?.dataset.docOpen;
      const removeDoc = event.target.closest('[data-doc-remove]')?.dataset.docRemove;
      try {
        if (act) await ({ approve: approveCase, decline: declineCase, edit: editCase, close: closeCase, addDocs: addDocuments })[act](cur);
        if (taskId) doTask(cur, cur.tasks.find((t) => t.id === taskId));
        if (undoId) await undoTask(cur, cur.tasks.find((t) => t.id === undoId));
        if (openDoc) await api.openDocument(id, openDoc);
        if (removeDoc) await removeDocument(cur, cur.documents.find((d) => d.id === removeDoc));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    // Files dropped anywhere on the case's window are added to it.
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    dlg.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dlg.classList.add('dropping');
    });
    dlg.addEventListener('dragleave', (event) => {
      if (!event.relatedTarget || !dlg.contains(event.relatedTarget)) dlg.classList.remove('dropping');
    });
    dlg.addEventListener('drop', async (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dlg.classList.remove('dropping');
      try {
        const added = await api.dropDocuments(id, event.dataTransfer.files);
        await afterChange(`Added ${plural(added, 'document')}.`);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function fileSize(bytes) {
    if (typeof bytes !== 'number') return '';
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function addDocuments(c) {
    const added = await api.chooseDocuments(c.id);
    if (added) await afterChange(`Added ${plural(added, 'document')}.`);
  }

  async function removeDocument(c, doc) {
    if (!doc || !window.confirm(`Remove ${doc.name} from this case? Its copy in the AB Apps folder is deleted too.`)) return;
    await api.removeDocument(c.id, doc.id);
    await afterChange(`Removed ${doc.name}.`);
  }

  /** Redraws an open case dialog after a change. */
  function refreshCaseDialog() {
    if (!detailId) return;
    const dlg = [...document.querySelectorAll('dialog.wide')].pop();
    const c = caseById(detailId);
    if (!dlg || !c) return;
    $('h2', dlg).textContent = c.who.name;
    $('.dialog-body', dlg).innerHTML = caseBody(c);
  }

  // Pages -----------------------------------------------------------------

  function taskRow(t) {
    const c = t.case;
    const overdue = !t.done && t.due < state.today;
    const amount = t.kind === 'payment' ? `${money(c.amount)} · ${METHOD[c.method]}` : `Approved through ${date(c.approvedThrough)}`;
    let action;
    if (t.done) action = t.done.outcome === 'renew' || c.status !== 'approved' ? '' : `<button class="link" data-undo="${esc(t.id)}" data-case="${esc(c.id)}">Undo</button>`;
    else action = `<button class="btn ${t.due <= state.today ? 'btn-primary' : 'btn-secondary'} btn-sm" data-task="${esc(t.id)}" data-case="${esc(c.id)}">${t.kind === 'review' ? 'Review…' : 'Mark done…'}</button>`;
    const when = t.done
      ? `${esc(date(t.done.on))}<span class="muted small">${esc(t.done.by)}</span>`
      : `${esc(date(t.due))}<span class="small ${overdue ? 'overdue' : 'muted'}">${esc(dueText(t.due))}</span>`;
    return `
      <tr class="${overdue ? 'due' : ''}">
        <td class="when">${when}</td>
        <td><strong>${esc(t.label)}</strong>${t.done?.note ? `<br><span class="muted small">${esc(t.done.note)}</span>` : ''}</td>
        <td><button class="link inline" data-open="${esc(c.id)}">${esc(c.who.name)}</button><br><span class="muted small">${esc(c.summary)}</span></td>
        <td class="small">${esc(amount)}</td>
        <td class="right">${action}</td>
      </tr>`;
  }

  function taskTable(tasks, empty) {
    if (!tasks.length) return `<p class="empty muted">${esc(empty)}</p>`;
    return `<table class="table tasks"><thead><tr><th>When</th><th>Task</th><th>For</th><th>Amount</th><th></th></tr></thead><tbody>${tasks.map(taskRow).join('')}</tbody></table>`;
  }

  function renderTasks() {
    const tasks = allTasks();
    const soon = S.addDays(state.today, 90);
    const recent = S.addDays(state.today, -45);
    const due = tasks.filter((t) => isOpen(t) && t.due <= state.today).sort((a, b) => a.due.localeCompare(b.due));
    const upcoming = tasks.filter((t) => isOpen(t) && t.due > state.today && t.due <= soon).sort((a, b) => a.due.localeCompare(b.due));
    const done = tasks.filter((t) => t.done && t.done.on >= recent).sort((a, b) => b.done.at.localeCompare(a.done.at));
    $('#tasks-page').innerHTML = `
      <div class="page-head">
        <h1>Tasks</h1>
        <div class="actions"><button class="btn btn-secondary" data-new>New request…</button></div>
      </div>
      <p class="muted intro">The reminder email lists what's due here every day until it's marked done.</p>
      <h2 class="section-title">Due now${due.length ? ` <span class="muted count">${due.length}</span>` : ''}</h2>
      ${taskTable(due, 'Nothing is due.')}
      <h2 class="section-title">Coming up in the next 90 days</h2>
      ${taskTable(upcoming, 'Nothing else comes due in the next 90 days.')}
      <h2 class="section-title">Done lately</h2>
      ${taskTable(done, 'Nothing has been marked done in the last 45 days.')}`;
  }

  const FILTERS = [
    ['open', 'Waiting and active', (c) => c.state === 'requested' || c.state === 'active'],
    ['requested', 'Waiting for a decision', (c) => c.state === 'requested'],
    ['active', 'Active', (c) => c.state === 'active'],
    ['past', 'Ended, closed or declined', (c) => ['ended', 'closed', 'declined'].includes(c.state)],
    ['all', 'All', () => true],
  ];

  function nextTaskText(c) {
    const next = c.tasks.find((t) => !t.done && c.status === 'approved');
    return next ? `${next.label} · ${date(next.due)}` : '';
  }

  function renderCases() {
    const words = caseQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const test = FILTERS.find(([key]) => key === caseFilter)[2];
    const shown = state.cases
      .filter(test)
      .filter((c) => words.every((w) => `${c.who.name} ${c.who.detail} ${c.summary} ${c.recipient.memberId}`.toLowerCase().includes(w)))
      .sort((a, b) => a.who.name.localeCompare(b.who.name));
    $('#cases-page').innerHTML = `
      <div class="page-head">
        <h1>Cases</h1>
        <div class="actions"><button class="btn btn-primary" data-new>New request…</button></div>
      </div>
      <div class="filters">
        <div class="chips">${FILTERS.map(([key, label]) => `<button class="btn btn-sm btn-ghost" aria-pressed="${key === caseFilter}" data-filter="${key}">${esc(label)}</button>`).join('')}</div>
        <input type="search" id="case-search" placeholder="Search cases" value="${esc(caseQuery)}">
      </div>
      ${shown.length ? `
        <table class="table cases">
          <thead><tr><th>For</th><th>What it is for</th><th>Status</th><th>Each quarter</th><th>Next</th></tr></thead>
          <tbody>${shown.map((c) => `
            <tr class="clickable" data-open="${esc(c.id)}">
              <td><strong>${esc(c.who.name)}</strong>${c.who.detail ? `<br><span class="muted small">${esc(c.who.detail)}</span>` : ''}</td>
              <td>${esc(c.summary)}</td>
              <td><span class="tag ${STATE[c.state][1]}">${esc(STATE[c.state][0])}</span>${c.approvedThrough && c.state === 'active' ? `<br><span class="muted small">through ${esc(date(c.approvedThrough))}</span>` : ''}</td>
              <td>${esc(money(c.amount))}<br><span class="muted small">${esc(METHOD[c.method])}</span></td>
              <td class="small">${esc(nextTaskText(c))}</td>
            </tr>`).join('')}</tbody>
        </table>` : `<p class="empty muted">${state.cases.length ? 'No cases match.' : 'No cases yet. Add the first request with New request.'}</p>`}`;
    const search = $('#case-search');
    search.addEventListener('input', () => {
      caseQuery = search.value;
      const at = search.selectionStart;
      renderCases();
      const again = $('#case-search');
      again.focus();
      again.setSelectionRange(at, at);
    });
  }

  function renderSettings() {
    const r = state.reminders;
    const status = r.error
      ? `<p class="warn">The reminders file couldn't be written: ${esc(r.error)}</p>`
      : r.skipped
        ? `<p class="warn">Not updated just now: ${esc(r.skipped)}.</p>`
        : `<p class="muted small">${r.writtenAt ? `Last changed ${esc(new Date(r.writtenAt).toLocaleString())}.` : 'Not written yet.'}</p>`;
    $('#settings-page').innerHTML = `
      <div class="page-head"><h1>Settings</h1></div>

      <h2 class="section-title">Reminder email</h2>
      <form id="settings-form" class="stack">
        ${field('Send reminders to', input('reminderEmail', state.settings.reminderEmail, `placeholder="office@example.org" ${state.isManager ? '' : 'disabled'}`),
          state.isManager ? 'One or more addresses, separated by semicolons. Power Automate sends to whoever is here.' : 'Only a manager can change this.')}
        ${state.isManager ? '<div><button class="btn btn-primary" type="submit">Save</button></div>' : ''}
        ${state.settings.updatedBy ? `<p class="muted small">Last changed by ${esc(state.settings.updatedBy)}, ${esc(new Date(state.settings.updatedAt).toLocaleString())}.</p>` : ''}
      </form>

      <h2 class="section-title">Power Automate</h2>
      <p>A Power Automate flow reads the reminders file every morning and emails the tasks that are due, and keeps emailing them each day until they're marked done here. When nothing is due, it sends nothing.</p>
      <p>The file lists every open task with its due date, so the flow doesn't need anyone to open AlmsManager first. Any computer with AlmsManager open keeps it up to date.</p>
      <div class="path-box"><code>${esc(r.path)}</code></div>
      ${status}
      <div class="actions">
        <button class="btn btn-secondary" data-copy-path>Copy file path</button>
        <button class="btn btn-secondary" data-open-folder>Open folder</button>
        <button class="btn btn-ghost" data-docs>How to set up the flow</button>
      </div>

      <h2 class="section-title">MemberManager</h2>
      <p>${state.members.available ? `Members and churches come from MemberManager's list (${state.members.count.toLocaleString()} to choose from).` : "MemberManager's list can't be read. Cases can still be added by typing a name; edit them later to link them."}</p>

      <h2 class="section-title">About</h2>
      <p>AlmsManager ${esc(state.version)}${state.update?.newer ? ` · <strong>${esc(state.update.version)} is available</strong>` : ''}</p>
      <div class="actions">
        <button class="btn btn-secondary" data-check-update>Check for updates</button>
        ${state.update?.newer ? `<button class="btn btn-primary" data-install-update ${state.update.hasInstaller ? '' : 'disabled'}>Install ${esc(state.update.version)}</button><button class="btn btn-ghost" data-release-page>What's new</button>` : ''}
      </div>
      <p class="muted small" id="update-status"></p>`;
    $('#settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api.saveSettings(Object.fromEntries(new FormData(event.target)));
        await afterChange('Saved. The flow picks it up on its next run.');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function renderBlocked() {
    let html;
    if (!state.signedIn) {
      html = `<h1>Sign in to AB Apps</h1><p>AlmsManager uses whoever is signed in to AB Apps, and keeps its cases in the AB Apps folder. Open AB Apps and sign in; this window follows along.</p>`;
    } else {
      html = `<h1>The AB Apps folder can't be reached</h1><p>${esc(state.folderMissing)} isn't on this computer yet. If OneDrive is still setting up, wait for it to finish; this window follows along.</p>`;
    }
    $('#blocked-page').innerHTML = html;
  }

  function renderBanner() {
    const messages = [];
    if (state.unreadable?.length) messages.push(`${plural(state.unreadable.length, 'case file')} can't be read yet (${state.unreadable.join(', ')}). If OneDrive is syncing, wait a moment; otherwise restore it from OneDrive's version history.`);
    if (state.conflicts?.length) messages.push(`OneDrive kept two copies of ${state.conflicts.join(', ')}, changed on two computers at once. Check the case is right; then delete the copy named with a computer's name from the cases folder.`);
    if (state.settingsError) messages.push(state.settingsError);
    if (state.reminders?.error) messages.push(`The reminders file couldn't be written: ${state.reminders.error}`);
    if (state.signedIn && state.settings && !state.settings.reminderEmail) messages.push(`No one gets the reminder email yet. ${state.isManager ? 'Set who on the Settings page.' : 'A manager sets who on the Settings page.'}`);
    const banner = $('#banner');
    banner.innerHTML = messages.map((m) => `<p>${esc(m)}</p>`).join('');
    banner.hidden = !messages.length;
  }

  function render() {
    const ready = state.signedIn && !state.folderMissing;
    $('#who').textContent = state.name ? `Signed in as ${state.name}` : '';
    for (const tab of document.querySelectorAll('.tab')) {
      tab.classList.toggle('active', tab.dataset.view === view);
      tab.disabled = !ready;
    }
    for (const id of ['tasks', 'cases', 'settings', 'blocked']) {
      $(`#view-${id}`).hidden = ready ? id !== view : id !== 'blocked';
    }
    renderBanner();
    if (!ready) {
      renderBlocked();
      $('#due-count').hidden = true;
      $('#request-count').hidden = true;
      return;
    }
    const due = allTasks().filter((t) => isOpen(t) && t.due <= state.today).length;
    $('#due-count').textContent = due;
    $('#due-count').hidden = !due;
    const waiting = state.cases.filter((c) => c.state === 'requested').length;
    $('#request-count').textContent = waiting;
    $('#request-count').hidden = !waiting;
    if (view === 'tasks') renderTasks();
    if (view === 'cases') renderCases();
    // Not while someone is typing in it: a change from another computer would wipe what they typed.
    if (view === 'settings' && !document.activeElement?.closest('#settings-form')) renderSettings();
    refreshCaseDialog();
  }

  async function load() {
    try {
      state = await api.getState();
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Events ----------------------------------------------------------------

  document.addEventListener('click', async (event) => {
    if (event.target.closest('dialog')) return; // dialogs wire their own
    const el = event.target.closest('button, tr[data-open]');
    if (!el) return;
    const d = el.dataset;
    try {
      if (d.view) {
        view = d.view;
        render();
      } else if ('new' in d) newRequest();
      else if (d.open) showCase(d.open);
      else if (d.task) {
        const c = caseById(d.case);
        doTask(c, c.tasks.find((t) => t.id === d.task));
      } else if (d.undo) {
        const c = caseById(d.case);
        await undoTask(c, c.tasks.find((t) => t.id === d.undo));
      } else if (d.filter) {
        caseFilter = d.filter;
        renderCases();
      } else if ('copyPath' in d) {
        await api.copyRemindersPath();
        toast('Copied.');
      } else if ('openFolder' in d) await api.openFolder();
      else if ('docs' in d) await api.openDocs();
      else if ('checkUpdate' in d) {
        $('#update-status').textContent = 'Checking…';
        const result = await api.checkForUpdate();
        await load();
        $('#update-status').textContent = result.newer ? '' : `AlmsManager is up to date (${result.version} is the latest).`;
      } else if ('installUpdate' in d) await api.installUpdate();
      else if ('releasePage' in d) await api.openReleasePage();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // A file dropped outside a case's window does nothing, rather than opening in place of the app.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (event) => event.preventDefault());

  api.onStateChanged(load);
  api.onUpdateProgress(({ percent }) => {
    const el = $('#update-status');
    if (el) el.textContent = `Downloading the update… ${percent}%`;
  });
  load();
})();
