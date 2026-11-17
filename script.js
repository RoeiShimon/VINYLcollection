'use strict';

const STORAGE_KEY = 'vinyl-collection-v1';
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const $ = (selector) => document.querySelector(selector);
const searchInput = $('#album-search');
const resultsSection = $('#search-results');
const resultsGrid = $('#results-grid');
const searchStatus = $('#search-status');
const albumDialog = $('#album-dialog');
let collection = [];
let storageHealthy = true;
let selectedAlbum = null;
let dialogMode = 'add';
let confirmingRemoval = false;
let searchController;
let searchVersion = 0;
let toastTimer;
let artworkVersion = 0;
let tracklistVersion = 0;
let activeSearchQuery = '';
const dataCache = new Map();
let musicBrainzQueue = Promise.resolve();
let lastMusicBrainzRequest = 0;

function isImageUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isAlbum(album) {
  return album !== null && typeof album === 'object'
    && typeof album.id === 'string' && (MBID.test(album.id) || /^itunes:\d+$/.test(album.id))
    && typeof album.title === 'string' && album.title.trim().length > 0
    && typeof album.artist === 'string' && album.artist.trim().length > 0
    && (album.year === null || (Number.isInteger(album.year) && album.year > 0 && album.year < 10000))
    && Number.isFinite(album.addedAt)
    && (album.releaseId === undefined || (typeof album.releaseId === 'string' && MBID.test(album.releaseId)))
    && (album.artworkUrl === undefined || isImageUrl(album.artworkUrl))
    && (album.customArtworkUrl === undefined || isImageUrl(album.customArtworkUrl));
}

function storageError(message, error) {
  storageHealthy = false;
  $('#storage-warning').textContent = message;
  $('#storage-warning').hidden = false;
  console.error(message, error);
}

function loadCollection() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored === null ? [] : JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every(isAlbum)
      || new Set(parsed.map((album) => album.id)).size !== parsed.length) {
      throw new Error('Stored collection has an invalid format.');
    }
    collection = parsed;
    storageHealthy = true;
    $('#storage-warning').hidden = true;
  } catch (error) {
    storageError('Your saved collection could not be read. To protect your records, saving is disabled. Check browser storage permissions or restore your browser data, then reload.', error);
  }
}

function saveCollection(nextCollection) {
  if (!storageHealthy) {
    $('#dialog-status').textContent = 'Saving is unavailable. Please resolve the browser storage warning and reload.';
    return false;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextCollection));
    collection = nextCollection;
    return true;
  } catch (error) {
    storageError('Your browser could not save the collection. No changes were made. Check available storage and browser permissions, then reload.', error);
    $('#dialog-status').textContent = 'Could not save this change. Your collection has not been changed.';
    return false;
  }
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeCover(album, eager = false) {
  const cover = makeElement('div', 'cover');
  const fallback = makeElement('div', 'cover-fallback');
  fallback.setAttribute('role', 'img');
  fallback.setAttribute('aria-label', `No artwork available for ${album.title}`);
  const disc = makeElement('span', 'fallback-disc');
  disc.setAttribute('aria-hidden', 'true');
  const label = makeElement('span', 'fallback-label', 'ARTWORK UNAVAILABLE');
  fallback.append(disc, label);
  cover.append(fallback);
  const urls = [];
  if (album.customArtworkUrl) urls.push(album.customArtworkUrl);
  if (album.artworkUrl) {
    // Change only Apple's size suffix, retaining the exact artwork asset.
    const url = new URL(album.artworkUrl);
    if (url.hostname.endsWith('.mzstatic.com')) {
      urls.push(album.artworkUrl.replace(/\/100x100bb(\.[a-z]+)(?=\?|$)/i, '/600x600bb$1'));
    }
    urls.push(album.artworkUrl);
  } else if (MBID.test(album.id)) {
    // Previously saved MusicBrainz records keep their identity and artwork.
    urls.push(`https://coverartarchive.org/release-group/${album.id}/front-500`);
    if (album.releaseId) urls.push(`https://coverartarchive.org/release/${album.releaseId}/front-500`);
  }
  const candidates = [...new Set(urls)];
  if (!candidates.length) return cover;
  label.textContent = 'LOADING ARTWORK';
  fallback.setAttribute('aria-label', `Loading artwork for ${album.title}`);
  const image = new Image();
  image.alt = `${album.title} album cover`;
  image.loading = eager ? 'eager' : 'lazy';
  image.decoding = 'async';
  // Keep lazy images in the layout so the browser actually starts loading them.
  image.style.opacity = '0';
  image.addEventListener('load', () => {
    image.style.opacity = '1';
    fallback.hidden = true;
  });
  image.addEventListener('error', () => {
    if (candidates.length) {
      image.src = candidates.shift();
      return;
    }
    image.remove();
    fallback.hidden = false;
    label.textContent = 'ARTWORK UNAVAILABLE';
    fallback.setAttribute('aria-label', `No artwork available for ${album.title}. Open details to provide an image URL.`);
  });
  image.src = candidates.shift();
  cover.append(image);
  return cover;
}

function normalizeText(value) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function albumKey(album) {
  return JSON.stringify([normalizeText(album.artist), normalizeText(album.title)]);
}

function sameAlbum(first, second) {
  return first.id === second.id || albumKey(first) === albumKey(second);
}

function ownsAlbum(album) {
  return collection.some((item) => sameAlbum(item, album));
}

function makeCard(album, mode) {
  const button = makeElement('button', 'album-card');
  button.type = 'button';
  button.dataset.albumId = album.id;
  button.setAttribute('aria-label', `${album.title} by ${album.artist}, ${album.year ?? 'year unknown'}${ownsAlbum(album) ? ', in your collection' : ''}. View details`);
  const details = makeElement('span', 'album-year');
  details.append(makeElement('span', '', album.year === null ? 'Year unknown' : String(album.year)));
  if (ownsAlbum(album)) details.append(makeElement('span', 'owned-label', 'In collection'));
  button.append(makeCover(album), makeElement('span', 'album-title', album.title),
    makeElement('span', 'album-artist', album.artist), details);
  button.addEventListener('click', () => openAlbum(
    mode === 'add' ? searchAlbums.find((item) => item.id === album.id) ?? album : album, mode));
  return button;
}

function renderCollection() {
  const count = collection.length;
  $('#nav-count').textContent = String(count);
  $('#collection-count').textContent = String(count);
  $('#record-summary').textContent = count === 0 ? '0 records. Endless possibilities.'
    : `${count} ${count === 1 ? 'record' : 'records'}. A collection that sounds like you.`;
  const filter = $('#collection-filter').value.trim().toLocaleLowerCase();
  const visible = collection.filter((album) =>
    `${album.title} ${album.artist} ${album.year ?? ''}`.toLocaleLowerCase().includes(filter));
  const sort = $('#sort-order').value;
  visible.sort((a, b) => {
    if (sort === 'artist' || sort === 'title') return a[sort].localeCompare(b[sort]);
    if (sort === 'year') return (a.year ?? Infinity) - (b.year ?? Infinity) || a.title.localeCompare(b.title);
    return b.addedAt - a.addedAt;
  });
  $('#collection-grid').replaceChildren(...visible.map((album) => makeCard(album, 'collection')));
  $('#empty-collection').hidden = count !== 0;
  $('#no-filter-results').hidden = count === 0 || visible.length !== 0;
}

function focusSearch() {
  searchInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
  searchInput.focus({ preventScroll: true });
}

function showToast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function openAlbum(album, mode) {
  artworkVersion++;
  selectedAlbum = collection.find((item) => sameAlbum(item, album)) ?? album;
  album = selectedAlbum;
  dialogMode = mode;
  confirmingRemoval = false;
  $('#dialog-title').textContent = album.title;
  $('#dialog-artist').textContent = album.artist;
  $('#dialog-year').textContent = album.year === null ? 'Release year unknown' : `Released in ${album.year}`;
  $('#dialog-art').replaceChildren(makeCover(album, true));
  const legacy = MBID.test(album.id);
  $('#album-source').href = legacy ? `https://musicbrainz.org/release-group/${album.id}`
    : `https://music.apple.com/album/id${album.id.slice(7)}`;
  $('#album-source').textContent = legacy ? 'View on MusicBrainz ↗' : 'View on Apple Music ↗';
  $('#custom-artwork').open = false;
  $('#artwork-url').value = album.customArtworkUrl ?? '';
  $('#artwork-status').textContent = '';
  $('#artwork-apply').disabled = false;
  $('#artwork-apply').textContent = 'Use image';
  $('#dialog-status').textContent = '';
  updateDialogAction();
  albumDialog.showModal();
  loadTracklist(album);
}

function cachedData(key, load) {
  if (!dataCache.has(key)) {
    dataCache.set(key, load().catch((error) => {
      dataCache.delete(key);
      throw error;
    }));
  }
  return dataCache.get(key);
}

async function fetchWithTimeout(url, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error('The music service took too long to respond. Please try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function musicBrainzRequest(path, params, signal) {
  const request = musicBrainzQueue.then(async () => {
    const url = `https://musicbrainz.org/ws/2/${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1100 - (Date.now() - lastMusicBrainzRequest))));
      signal?.throwIfAborted();
      lastMusicBrainzRequest = Date.now();
      const response = await fetchWithTimeout(url, signal);
      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        const retryHeader = response.headers.get('Retry-After');
        const retryAfter = Number(retryHeader);
        const backoff = 2200 * (attempt + 1);
        const delay = retryHeader && !Number.isFinite(retryAfter)
          ? Math.max(backoff, Date.parse(retryHeader) - Date.now() || 0)
          : Math.max(backoff, retryAfter > 0 ? retryAfter * 1000 : 0);
        if (delay > 10000) throw Object.assign(
          new Error('MusicBrainz has asked us to wait before trying again. Please try again later.'),
          { status: response.status, retryLater: true });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (!response.ok) throw Object.assign(new Error(response.status === 429 || response.status === 503
        ? 'MusicBrainz is temporarily busy. Your existing results are still available; please try again shortly.'
        : `MusicBrainz could not retrieve this information (${response.status}). Please try again.`),
      { status: response.status });
      return response.json();
    }
  });
  // A failed job must not prevent subsequent searches or tracklist lookups.
  musicBrainzQueue = request.then(() => undefined, () => undefined);
  return request;
}

function formatDuration(milliseconds, albumTotal = false) {
  if (milliseconds === null) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, '0');
  return albumTotal && minutes >= 60
    ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${tail}`
    : `${String(minutes).padStart(2, '0')}:${tail}`;
}

function validateTracks(tracks) {
  if (!tracks.length) throw new Error('No song tracklist is available for this edition yet.');
  const positions = new Set();
  for (const track of tracks) {
    const key = `${track.disc}:${track.number}`;
    if (!Number.isInteger(track.disc) || track.disc < 1
      || !Number.isInteger(track.number) || track.number < 1
      || typeof track.title !== 'string' || !track.title.trim() || positions.has(key)) {
      throw new Error('This edition has incomplete or ambiguous track information. No tracklist is shown to avoid incorrect data.');
    }
    positions.add(key);
    if (!Number.isFinite(track.duration) || track.duration < 0) track.duration = null;
  }
  tracks.sort((a, b) => a.disc - b.disc || a.number - b.number);
  for (let index = 0; index < tracks.length; index++) {
    const previous = tracks[index - 1];
    const expected = previous?.disc === tracks[index].disc ? previous.number + 1 : 1;
    if (tracks[index].number !== expected) throw new Error('Some tracks are missing from this edition. Please try again or choose another edition.');
  }
  return tracks;
}

function iTunesTracklist(album) {
  return cachedData(`tracks:${album.id}`, async () => {
    const id = Number(album.id.slice(7));
    const params = new URLSearchParams({ id: String(id), entity: 'song', limit: '200' });
    const response = await fetchWithTimeout(`https://itunes.apple.com/lookup?${params}`);
    if (!response.ok) throw new Error(`Apple iTunes could not retrieve this tracklist (${response.status}). Please try again.`);
    const data = await response.json();
    if (!Array.isArray(data.results)) throw new Error('Apple iTunes returned an unreadable tracklist.');
    const metadata = data.results.find((item) => item.wrapperType === 'collection' && item.collectionId === id);
    const songs = data.results.filter((item) => item.wrapperType === 'track' && item.kind === 'song' && item.collectionId === id);
    if (!metadata || !sameAlbum(album, { id: '', title: metadata.collectionName ?? '', artist: metadata.artistName ?? '' })) {
      throw new Error('The returned album does not match your saved record. No tracklist is shown to avoid using a different edition.');
    }
    if (data.results.length >= 200 && metadata.trackCount > songs.length) {
      throw new Error('This edition exceeds the lookup limit, so its complete tracklist could not be verified.');
    }
    const tracks = validateTracks(songs.map((song) => ({
      disc: song.discNumber, number: song.trackNumber, title: song.trackName, duration: song.trackTimeMillis
    })));
    return { tracks, source: `https://music.apple.com/album/id${id}`, label: 'Songs from this exact Apple iTunes album listing.' };
  });
}

const NON_STANDARD_EDITION = /\b(deluxe|remaster(?:ed)?|anniversary|expanded|bonus|reissue|instrumental|karaoke|clean|edited|promo(?:tional)?)\b/i;

function editionLabel(release) {
  const formats = [...new Set((release.media ?? []).map((medium) => medium.format).filter(Boolean))].join(' + ');
  return [release.title, release.date || 'Date unknown', release.country, formats, release.disambiguation].filter(Boolean).join(' · ');
}

function musicBrainzEditions(album) {
  return cachedData(`editions:${album.id}`, async () => {
    const releases = [];
    let offset = 0;
    let count;
    do {
      const data = await musicBrainzRequest('release/', {
        'release-group': album.id, status: 'official', inc: 'media', limit: '100', offset: String(offset)
      });
      if (!Array.isArray(data.releases) || !Number.isInteger(data['release-count'])) throw new Error('MusicBrainz returned unreadable edition information.');
      releases.push(...data.releases);
      count = data['release-count'];
      offset += data.releases.length;
      if (offset < count && !data.releases.length) throw new Error('The full edition list could not be retrieved. Please try again.');
    } while (offset < count);
    const editions = releases.filter((release) => MBID.test(release.id) && release.status === 'Official'
      && Array.isArray(release.media) && release.media.some((medium) => medium['track-count'] > 0));
    const standard = (release) => normalizeText(release.title) === normalizeText(album.title)
      && !NON_STANDARD_EDITION.test(release.disambiguation ?? '')
      && !release.media.some((medium) => /DVD|Blu-ray|Video/i.test(medium.format ?? ''));
    editions.sort((a, b) => Number(standard(b)) - Number(standard(a))
      || (a.date || '9999').localeCompare(b.date || '9999') || a.id.localeCompare(b.id));
    return { editions, preferred: editions.find(standard) };
  });
}

function musicBrainzTracklist(album, releaseId) {
  return cachedData(`tracks:${album.id}:${releaseId}`, async () => {
    const data = await musicBrainzRequest(`release/${releaseId}`, { inc: 'recordings+release-groups' });
    if (data['release-group']?.id !== album.id || !Array.isArray(data.media)) {
      throw new Error('This release does not match the selected album. No tracklist is shown.');
    }
    const tracks = [];
    for (const medium of data.media) {
      if (!Array.isArray(medium.tracks) || medium.tracks.length !== medium['track-count']) {
        throw new Error('This edition has an incomplete tracklist. Please choose another edition.');
      }
      for (const track of medium.tracks) tracks.push({
        disc: medium.position, number: track.position, label: track.number,
        title: track.title, duration: track.length ?? track.recording?.length ?? null
      });
    }
    return {
      tracks: validateTracks(tracks),
      source: `https://musicbrainz.org/release/${releaseId}`,
      label: `Exact edition: ${editionLabel(data)}`
    };
  });
}

function renderTracklist(data) {
  const container = $('#tracklist-tracks');
  const discs = [...new Set(data.tracks.map((track) => track.disc))];
  for (const disc of discs) {
    const group = makeElement('li', 'tracklist-disc');
    if (discs.length > 1) group.append(makeElement('h4', '', `Disc ${disc}`));
    const list = makeElement('ol');
    for (const track of data.tracks.filter((item) => item.disc === disc)) {
      const row = makeElement('li', 'track-row');
      row.dataset.disc = String(disc);
      row.dataset.track = String(track.number);
      row.append(makeElement('span', 'track-number', track.label || String(track.number)),
        makeElement('span', 'track-title', track.title), makeElement('span', 'track-time', formatDuration(track.duration)));
      list.append(row);
    }
    group.append(list);
    container.append(group);
  }
  const completeDurations = data.tracks.every((track) => track.duration !== null);
  const total = completeDurations ? data.tracks.reduce((sum, track) => sum + track.duration, 0) : null;
  $('#tracklist-total').textContent = completeDurations
    ? `Total ${formatDuration(total, true)}`
    : 'Total duration unavailable';
  $('#album-runtime').textContent = total === null ? 'Duration unavailable'
    : `${Math.floor(total / 60000)} min ${Math.floor(total / 1000) % 60} sec`;
  $('#tracklist-status').textContent = `${data.tracks.length} songs${completeDurations ? '' : ' · Some track durations are unavailable'}`;
  $('#tracklist-source').href = data.source;
  $('#tracklist-source').textContent = data.label;
  $('#tracklist-source').hidden = false;
  container.hidden = false;
}

async function loadTracklist(album, releaseId) {
  const version = ++tracklistVersion;
  $('#tracklist-tracks').replaceChildren();
  $('#tracklist-tracks').hidden = true;
  $('#tracklist-total').textContent = '';
  $('#album-runtime').textContent = 'Loading…';
  $('#tracklist-source').hidden = true;
  $('#tracklist-retry').hidden = true;
  $('#edition-control').hidden = true;
  $('#tracklist-status').textContent = 'Loading tracklist…';
  $('#tracklist-tracks').setAttribute('aria-busy', 'true');
  try {
    let data;
    if (MBID.test(album.id)) {
      const { editions, preferred } = await musicBrainzEditions(album);
      if (version !== tracklistVersion || !albumDialog.open) return;
      const chosenId = releaseId ?? album.releaseId ?? preferred?.id;
      const select = $('#album-edition');
      select.replaceChildren(new Option('Choose an album edition', ''));
      for (const edition of editions) select.add(new Option(editionLabel(edition), edition.id));
      if (chosenId && !editions.some((edition) => edition.id === chosenId)) {
        select.add(new Option('Previously selected edition', chosenId));
      }
      select.value = chosenId ?? '';
      $('#edition-control').hidden = false;
      if (!chosenId) throw new Error('No original standard edition could be identified. Please choose the correct edition above.');
      selectedAlbum = { ...selectedAlbum, releaseId: chosenId };
      data = await musicBrainzTracklist(album, chosenId);
    } else data = await iTunesTracklist(album);
    if (version !== tracklistVersion || !albumDialog.open) return;
    renderTracklist(data);
  } catch (error) {
    if (version !== tracklistVersion || !albumDialog.open) return;
    console.error('Tracklist lookup failed:', error);
    $('#album-runtime').textContent = 'Duration unavailable';
    $('#tracklist-status').textContent = error instanceof TypeError
      ? 'Could not load the tracklist. Check your connection and try again.'
      : error instanceof SyntaxError ? 'The music service returned an unreadable tracklist. Please try again.' : error.message;
    $('#tracklist-retry').hidden = false;
  } finally {
    if (version === tracklistVersion) $('#tracklist-tracks').removeAttribute('aria-busy');
  }
}

$('#tracklist-retry').addEventListener('click', () => loadTracklist(selectedAlbum));
$('#album-edition').addEventListener('change', () => {
  const releaseId = $('#album-edition').value;
  if (!selectedAlbum || !MBID.test(releaseId)) return;
  if (ownsAlbum(selectedAlbum) && !saveCollection(collection.map((album) =>
    sameAlbum(album, selectedAlbum) ? { ...album, releaseId } : album))) {
    $('#album-edition').value = selectedAlbum.releaseId ?? '';
    updateDialogAction();
    return;
  }
  selectedAlbum = { ...selectedAlbum, releaseId };
  loadTracklist(selectedAlbum, releaseId);
});

function updateDialogAction() {
  const owned = ownsAlbum(selectedAlbum);
  const remove = dialogMode === 'collection' && owned;
  $('#dialog-eyebrow').textContent = remove ? 'ON YOUR SHELF' : 'MAKE ROOM ON THE SHELF';
  const action = $('#dialog-action');
  action.classList.toggle('remove', remove);
  action.disabled = (!remove && owned) || !storageHealthy;
  action.textContent = !storageHealthy ? 'Saving unavailable' : remove
    ? 'Remove from collection' : owned ? 'Already in your collection' : 'Add to collection';
}

$('#dialog-action').addEventListener('click', () => {
  if (!selectedAlbum) return;
  const removing = dialogMode === 'collection' && ownsAlbum(selectedAlbum);
  if (removing && !confirmingRemoval) {
    confirmingRemoval = true;
    $('#dialog-action').textContent = 'Yes, remove this record';
    $('#dialog-status').textContent = 'Remove this album from your collection? Click again to confirm, or close to keep it.';
    return;
  }
  if (!removing && ownsAlbum(selectedAlbum)) return;
  const next = removing ? collection.filter((album) => !sameAlbum(album, selectedAlbum))
    : [...collection, { ...selectedAlbum, addedAt: Date.now() }];
  if (!saveCollection(next)) {
    updateDialogAction();
    return;
  }
  renderCollection();
  // Keep search cards in sync without replacing their artwork or focus targets.
  resultsGrid.querySelectorAll('.album-card').forEach((card) => {
    const album = searchAlbums.find((item) => item.id === card.dataset.albumId);
    if (!album) return;
    const oldLabel = card.querySelector('.owned-label');
    if (ownsAlbum(album) && !oldLabel) card.querySelector('.album-year').append(makeElement('span', 'owned-label', 'In collection'));
    if (!ownsAlbum(album) && oldLabel) oldLabel.remove();
    card.setAttribute('aria-label', `${album.title} by ${album.artist}, ${album.year ?? 'year unknown'}${ownsAlbum(album) ? ', in your collection' : ''}. View details`);
  });
  albumDialog.close();
  if (removing) $('#collection-heading').scrollIntoView({ block: 'nearest' });
  showToast(removing ? `“${selectedAlbum.title}” removed from your collection.` : `“${selectedAlbum.title}” added to your collection.`);
});

function checkImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error) => {
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      if (error) {
        image.removeAttribute('src');
        reject(error);
      } else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('The image took too long to load. Try another direct image URL.')), 12000);
    image.onload = () => finish(image.naturalWidth > 0 ? null : new Error('This URL did not return a usable image.'));
    image.onerror = () => finish(new Error('The image could not be loaded. Check the URL and image host permissions.'));
    image.src = url;
  });
}

$('#artwork-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('#artwork-url').value.trim();
  const album = selectedAlbum;
  if (!album) return;
  if (!isImageUrl(url)) {
    $('#artwork-status').textContent = 'Enter a direct HTTP or HTTPS image URL without embedded credentials.';
    return;
  }
  $('#artwork-apply').disabled = true;
  const version = ++artworkVersion;
  $('#artwork-apply').textContent = 'Checking image…';
  $('#artwork-status').textContent = 'Checking that your image can be loaded…';
  try {
    await checkImage(url);
    if (version !== artworkVersion || !albumDialog.open) return;
    const updated = { ...selectedAlbum, customArtworkUrl: url };
    if (ownsAlbum(album)) {
      if (!saveCollection(collection.map((item) => sameAlbum(item, album)
        ? { ...item, customArtworkUrl: url } : item))) {
        $('#artwork-status').textContent = 'The image loaded, but could not be saved. Your artwork has not been changed.';
        updateDialogAction();
        return;
      }
      renderCollection();
    }
    searchAlbums = searchAlbums.map((item) => sameAlbum(item, album) ? { ...item, customArtworkUrl: url } : item);
    resultsGrid.querySelectorAll('.album-card').forEach((card) => {
      const result = searchAlbums.find((item) => item.id === card.dataset.albumId);
      if (result && sameAlbum(result, album)) card.querySelector('.cover').replaceWith(makeCover(result));
    });
    selectedAlbum = updated;
    $('#dialog-art').replaceChildren(makeCover(updated, true));
    $('#artwork-status').textContent = ownsAlbum(updated) ? 'Artwork updated and saved.' : 'Image ready. Add this album to save it with your collection.';
  } catch (error) {
    if (version !== artworkVersion || !albumDialog.open) return;
    console.error('Custom artwork failed:', error);
    $('#artwork-status').textContent = error.message;
  } finally {
    if (version === artworkVersion) {
      $('#artwork-apply').disabled = false;
      $('#artwork-apply').textContent = 'Use image';
    }
  }
});

$('#dialog-close').addEventListener('click', () => albumDialog.close());
albumDialog.addEventListener('close', () => { artworkVersion++; tracklistVersion++; });
albumDialog.addEventListener('click', (event) => {
  if (event.target !== albumDialog) return;
  const rect = albumDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) albumDialog.close();
});

let searchAlbums = [];

function cancelSearch() {
  searchVersion++;
  searchController?.abort();
  searchStatus.classList.remove('is-loading');
  resultsGrid.removeAttribute('aria-busy');
  $('#search-more').hidden = true;
}

function prepareSearch() {
  cancelSearch();
  const query = searchInput.value.trim();
  activeSearchQuery = query;
  resultsGrid.replaceChildren();
  searchAlbums = [];
  if (query.length < 2) {
    resultsSection.hidden = !query;
    searchStatus.textContent = query ? 'Type at least 2 characters to search for an album.' : '';
    return null;
  }
  resultsSection.hidden = false;
  searchStatus.textContent = 'Looking through the crates…';
  searchStatus.classList.add('is-loading');
  return { query, version: searchVersion };
}

async function fetchAlbums(query, signal) {
  const params = new URLSearchParams({ term: query, entity: 'album', media: 'music', limit: '50' });
  const response = await fetch(`https://itunes.apple.com/search?${params}`, { signal });
  if (!response.ok) {
    if (response.status === 429 || response.status === 503) throw new Error('Apple iTunes is receiving too many requests. Please wait a moment and try again.');
    throw new Error(`Apple iTunes returned an error (${response.status}). Please try again.`);
  }
  const data = await response.json();
  if (!Array.isArray(data.results)) throw new Error('Apple iTunes returned an unexpected response. Please try again.');
  const seenIds = new Set();
  const seenAlbums = new Set();
  return data.results.filter((item) => item && Number.isSafeInteger(item.collectionId) && item.collectionId > 0)
    .map((item) => {
      const date = typeof item.releaseDate === 'string' ? item.releaseDate : '';
      return {
        id: `itunes:${item.collectionId}`,
        title: item.collectionName,
        artist: item.artistName,
        year: /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null,
        ...(isImageUrl(item.artworkUrl100) ? { artworkUrl: item.artworkUrl100 } : {}),
        addedAt: 0
      };
    }).filter(isAlbum).filter((album) => {
      const key = albumKey(album);
      if (seenIds.has(album.id) || seenAlbums.has(key)) return false;
      seenIds.add(album.id);
      seenAlbums.add(key);
      return true;
    }).slice(0, 50);
}

function searchWords(query) {
  const words = normalizeText(query).split(' ');
  return words.some((word) => word !== 'by') ? words.filter((word) => word !== 'by') : words;
}

function albumMatch(album, query) {
  const words = searchWords(query);
  const normalized = words.join(' ');
  const title = normalizeText(album.title);
  const artist = normalizeText(album.artist);
  const tokens = new Set(`${title} ${artist}`.split(' '));
  const matches = words.filter((word) => tokens.has(word)).length;
  const exactPair = `${title} ${artist}` === normalized || `${artist} ${title}` === normalized;
  const nonStudio = /(?: - (?:single|ep)$|\bcompilation\b)/i.test(album.title)
    || (album.secondaryTypes ?? []).some((type) => ['Compilation', 'Live', 'Remix', 'DJ-mix'].includes(type));
  return {
    complete: matches === words.length,
    score: (exactPair ? 10000 : 0) + (title === normalized ? 3000 : 0)
      + (artist === normalized ? 2500 : 0) + (matches === words.length ? 1500 : 0) + matches * 20
      - (nonStudio ? 500 : 0) - (NON_STANDARD_EDITION.test(album.title) && !NON_STANDARD_EDITION.test(query) ? 100 : 0)
  };
}

function rankAlbums(albums, query) {
  const matches = albums.map((album) => ({ album, ...albumMatch(album, query) }));
  const relevant = matches.some((item) => item.complete) ? matches.filter((item) => item.complete) : matches;
  return relevant.sort((a, b) => b.score - a.score).map((item) => item.album);
}

function displaySearchAlbums(albums, query) {
  const unique = [];
  for (const album of albums) if (!unique.some((item) => sameAlbum(item, album))) unique.push(album);
  searchAlbums = rankAlbums(unique, query);
  resultsGrid.replaceChildren(...searchAlbums.map((album) => makeCard(album, 'add')));
}

async function musicBrainzSearchResults(match, signal) {
  const cacheKey = `album-search:${match}`;
  if (dataCache.has(cacheKey)) return dataCache.get(cacheKey);
  const data = await musicBrainzRequest('release-group/', {
    query: `primarytype:album AND ${match}`, limit: '50'
  }, signal);
  if (!Array.isArray(data['release-groups'])) throw new Error('MusicBrainz returned unreadable album results. Please try again.');
  const albums = data['release-groups'].map((group) => {
    const date = group['first-release-date'] ?? '';
    return {
      id: group.id, title: group.title,
      artist: (group['artist-credit'] ?? []).map((credit) => `${credit.name ?? credit.artist?.name ?? ''}${credit.joinphrase ?? ''}`).join('').trim(),
      year: /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null,
      secondaryTypes: Array.isArray(group['secondary-types']) ? group['secondary-types'] : [],
      addedAt: 0
    };
  }).filter(isAlbum);
  dataCache.set(cacheKey, albums);
  return albums;
}

async function searchMusicBrainz(query, signal, knownAlbums = [], broad = false) {
  const escape = (term) => term.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
  const terms = searchWords(query);
  const normalized = terms.join(' ');
  const broadMatch = terms.map((term) => `(releasegroup:"${escape(term)}" OR artist:"${escape(term)}")`).join(' AND ');
  const artist = [...new Set(knownAlbums.map((album) => normalizeText(album.artist)))]
    .filter((name) => name && ` ${normalized} `.includes(` ${name} `))
    .sort((a, b) => b.length - a.length)[0];
  const title = artist ? ` ${normalized} `.replace(` ${artist} `, ' ').trim() : '';
  const queries = broad ? [broadMatch] : title && artist ? [
    `releasegroup:"${escape(title)}" AND artist:"${escape(artist)}"`,
    `releasegroup:"${escape(title)}"`,
    `artist:"${escape(artist)}"`,
    broadMatch
  ] : [`(releasegroup:"${escape(normalized)}" OR artist:"${escape(normalized)}")`, broadMatch];
  let lastError;
  let partial = [];
  for (const match of new Set(queries)) {
    signal.throwIfAborted();
    try {
      const albums = await musicBrainzSearchResults(match, signal);
      if (albums.some((album) => albumMatch(album, query).complete)) return albums;
      partial = [...partial, ...albums];
    } catch (error) {
      if (error.status !== 503 || error.retryLater || signal.aborted) throw error;
      console.warn('MusicBrainz query remained busy; trying a simpler album/artist query.', error);
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return partial;
}

async function runSearch(search, more = false) {
  if (!search || search.version !== searchVersion) return;
  const controller = new AbortController();
  searchController = controller;
  resultsGrid.setAttribute('aria-busy', 'true');
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);
  try {
    const primary = more ? [...searchAlbums] : await fetchAlbums(search.query, controller.signal);
    if (search.version !== searchVersion) return;
    if (!more) displaySearchAlbums(primary, search.query);
    searchStatus.textContent = more ? 'Searching more albums on MusicBrainz…'
      : 'iTunes results ready. Checking MusicBrainz for additional matches…';
    const albums = await searchMusicBrainz(search.query, controller.signal, primary, more);
    if (search.version !== searchVersion) return;
    const added = albums.filter((album) => !primary.some((item) => sameAlbum(item, album))).length;
    displaySearchAlbums([...primary, ...albums], search.query);
    $('#search-more').hidden = more;
    const partial = searchAlbums.length && !searchAlbums.some((album) => albumMatch(album, search.query).complete);
    searchStatus.textContent = more
      ? `${added} additional ${added === 1 ? 'album' : 'albums'} retrieved from MusicBrainz. ${searchAlbums.length} matching ${searchAlbums.length === 1 ? 'result' : 'results'}.`
      : partial ? `No exact album or artist match found for “${search.query}”. Showing partial matches; try a more specific title or artist.`
      : searchAlbums.length
      ? `${searchAlbums.length} matching ${searchAlbums.length === 1 ? 'album' : 'albums'} found for “${search.query}” across iTunes and MusicBrainz.`
      : `No albums found for “${search.query}”. Try a different album title or artist, or check the spelling.`;
  } catch (error) {
    if (search.version !== searchVersion) return;
    if (error.name === 'AbortError' && !timedOut) return;
    console.error('Album search failed:', error);
    $('#search-more').hidden = false;
    searchStatus.textContent = timedOut ? 'The search took too long. Please try again.'
      : error instanceof TypeError ? 'Could not reach the music service. Check your internet connection and try again.'
        : error instanceof SyntaxError ? 'The music service returned an unreadable response. Please try again.'
        : error.message;
  } finally {
    clearTimeout(timeout);
    if (search.version === searchVersion) {
      resultsGrid.removeAttribute('aria-busy');
      searchStatus.classList.remove('is-loading');
    }
  }
}

$('#search-more').addEventListener('click', () => {
  if (!activeSearchQuery) return;
  cancelSearch();
  searchStatus.textContent = 'Searching more albums on MusicBrainz…';
  searchStatus.classList.add('is-loading');
  runSearch({ query: activeSearchQuery, version: searchVersion }, true);
});

searchInput.addEventListener('input', () => {
  cancelSearch();
  if (!resultsSection.hidden) searchStatus.textContent = 'Press Enter or click the search arrow to search albums and artists.';
});
$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const search = prepareSearch();
  if (search) {
    runSearch(search);
    resultsSection.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } else focusSearch();
});
document.querySelectorAll('[data-query]').forEach((button) => {
  button.addEventListener('click', () => {
    searchInput.value = button.dataset.query;
    searchInput.dispatchEvent(new Event('input'));
    focusSearch();
  });
});
$('#close-search').addEventListener('click', () => {
  cancelSearch();
  searchInput.value = '';
  resultsSection.hidden = true;
  resultsGrid.replaceChildren();
  resultsGrid.removeAttribute('aria-busy');
  searchInput.focus();
});
$('#header-add').addEventListener('click', focusSearch);
$('#empty-add').addEventListener('click', focusSearch);
$('#collection-filter').addEventListener('input', renderCollection);
$('#sort-order').addEventListener('change', renderCollection);
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  loadCollection();
  renderCollection();
  if (albumDialog.open && selectedAlbum) {
    confirmingRemoval = false;
    updateDialogAction();
  }
});

loadCollection();
renderCollection();
