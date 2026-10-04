const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', '/setup.html');
const form = document.querySelector('#setup-form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const result = document.querySelector('#setup-result');
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/setup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
      token, members: [document.querySelector('#first-name').value.trim(), document.querySelector('#second-name').value.trim()],
      passwords: [document.querySelector('#first-password').value, document.querySelector('#second-password').value]
    })});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Instellen is niet gelukt.');
    form.reset(); location.replace('/');
  } catch (error) { result.textContent = error.message; button.disabled = false; }
});
