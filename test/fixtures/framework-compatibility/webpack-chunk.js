window.fixtureWebpackChunk = function (root) {
  root.textContent = 'webpack chunk loaded';
  const img = document.createElement('img');
  img.alt = 'chunk image';
  img.dataset.fixture = 'webpack-image';
  img.src = './webpack-image.svg';
  root.appendChild(img);
};
