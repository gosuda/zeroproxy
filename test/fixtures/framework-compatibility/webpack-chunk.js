window.fixtureWebpackChunk = function (root) {
  root.textContent = 'webpack chunk loaded';
  const img = document.createElement('img');
  img.alt = 'chunk image';
  img.src = './webpack-image.png';
  root.appendChild(img);
};
