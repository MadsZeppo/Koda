const $ = id => document.getElementById(id);
let repo, busy = false;
$('api').value = localStorage.getItem('api') || $('api').value;
function message(text, kind) { const el = document.createElement('div'); el.className = 'message ' + kind; el.textContent = text; $('chat').append(el); el.scrollIntoView(); }
async function refreshHistory() { $('history').replaceChildren(); for (const item of (await window.koda.history()).reverse()) { const button = document.createElement('button'); button.textContent = item.task.slice(0, 65); button.title = item.repo; button.onclick = () => { $('task').value = item.task; }; $('history').append(button); } }
$('folder').onclick = async () => { try { repo = await window.koda.folder(); $('repo').textContent = repo || 'Intet projekt valgt'; $('send').disabled = !repo || busy; } catch (error) { message(error.message, 'failure'); } };
window.koda.onLog(text => { $('logs').textContent = ($('logs').textContent + text).slice(-100000); $('logs').scrollTop = $('logs').scrollHeight; });
$('report').onclick = () => window.koda.report();
$('form').onsubmit = async event => {
  event.preventDefault(); if (busy || !repo) return;
  const task = $('task').value.trim(); if (!task) return;
  busy = true; $('send').disabled = true; $('folder').disabled = true; $('report').disabled = true; $('logs').textContent = ''; $('status').textContent = 'Koda arbejder · følg live-loggen nedenfor';
  document.querySelector('.welcome')?.remove(); message(task, 'user'); localStorage.setItem('api', $('api').value);
  try {
    const result = await window.koda.run({ repo, task, apiUrl: $('api').value, budgetUsd: Number($('budget').value), apply: $('apply').checked });
    const summary = result.summary;
    const success = summary?.status === 'VERIFIED_SUCCESS';
    message(summary ? `${summary.status}\nApply: ${summary.applyResult ?? 'preview'}\n${(summary.candidateChangedFiles || summary.changedFiles || []).join('\n')}\n\nRapport: ${result.output}` : `Kørslen kunne ikke fuldføres. ${result.error || 'Se live-loggen for fejlen.'}`, success ? 'result' : 'failure');
    $('status').textContent = success ? 'Verificeret · se apply-status i resultatet' : 'Ikke fuldt verificeret · se rapporten'; $('report').disabled = false; $('task').value = ''; await refreshHistory();
  } catch (error) { message(error.message, 'failure'); $('status').textContent = 'Kørslen fejlede'; }
  finally { busy = false; $('send').disabled = !repo; $('folder').disabled = false; }
};
refreshHistory();
