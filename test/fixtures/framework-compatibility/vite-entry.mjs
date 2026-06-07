const app = document.getElementById('app');
app.textContent = 'entry loaded';
const chunk = await import('fixture:chunk');
chunk.mount(app);
