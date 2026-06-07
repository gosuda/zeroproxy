export function mount(app) {
  const button = document.createElement('button');
  button.dataset.fixture = 'vite-dynamic-chunk';
  button.textContent = 'dynamic chunk mounted';
  button.addEventListener('click', () => {
    button.textContent = 'dynamic chunk clicked';
  });
  app.append(button);
}
