import { $, api, copy, fmtDur } from './common.js';

const token = location.pathname.split('/')[2];
(async () => {
  try {
    const info = await api(`/s/${token}/info`);
    document.title = info.name;
    $('#title').textContent = info.name;
    $('#meta').textContent = [info.dedication, `${info.pieces} pieces from the family`, fmtDur(info.duration)].filter(Boolean).join(' · ');
    $('#video').poster = `/s/${token}/poster.jpg?v=${info.version}`;
    $('#video').src = `/s/${token}/video.mp4?v=${info.version}`;
    $('#download').href = `/s/${token}/video.mp4?download=1&v=${info.version}`;
  } catch (err) {
    $('#title').textContent = 'This link is no longer active';
    $('#meta').textContent = 'Ask your host for the latest link.';
  }
  $('#copyLink').onclick = () => copy(location.href);
})();
