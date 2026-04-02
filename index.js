const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Cache en mémoire
let animeList = [];
let isInitialized = false;

// Configuration - Cachée
const CONFIG = {
  currentDomain: 'anime-sama.to',
  baseUrl: 'https://anime-sama.to',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// AnimeInfo depuis source cachée
const ANIME_INFO_URL = 'https://raw.githubusercontent.com/afrinode-dev/ANIME-JSON/refs/heads/main/anime.json';

// Types de lecteurs
const playerTypes = {
  'vidmoly': 'Vidmoly',
  'sibnet': 'Sibnet',
  'oneupload': 'OneUpload',
  'sendvid': 'Sendvid',
  'smoothpre': 'Smoothpre',
  'dood': 'DoodStream',
  'mp4upload': 'Mp4Upload',
  'streamtape': 'Streamtape',
  'voe': 'Voe',
  'mixdrop': 'MixDrop',
  'streamsb': 'StreamSB',
  'fembed': 'Fembed',
  'jawcloud': 'Jawcloud',
  'uqload': 'Uqload',
  'vidcloud': 'Vidcloud',
  'youtube': 'YouTube',
  'ok.ru': 'OK.ru'
};

// ==================== FONCTIONS DE PARSING ====================

function normalizeSlug(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function checkUrlExists(url) {
  try {
    const response = await axios.head(url, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 5000,
      maxRedirects: 5
    });
    return response.status === 200;
  } catch (error) {
    try {
      const getResponse = await axios.get(url, {
        headers: { 'User-Agent': CONFIG.userAgent },
        timeout: 5000,
        maxRedirects: 5,
        validateStatus: (status) => status < 400
      });
      return getResponse.status === 200;
    } catch (e) {
      return false;
    }
  }
}

async function extractThumbnail(html) {
  try {
    const $ = cheerio.load(html);
    let thumbnail =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('.poster img').attr('src') ||
      $('.thumbnail img').attr('src') ||
      $('.wp-post-image').attr('src');

    if (thumbnail) {
      if (thumbnail.startsWith('//')) {
        thumbnail = 'https:' + thumbnail;
      } else if (thumbnail.startsWith('/')) {
        thumbnail = CONFIG.baseUrl + thumbnail;
      } else if (!thumbnail.startsWith('http')) {
        thumbnail = CONFIG.baseUrl + '/' + thumbnail;
      }
    }

    return thumbnail || null;
  } catch (error) {
    return null;
  }
}

async function extractDescription(html) {
  try {
    const $ = cheerio.load(html);
    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      $('.entry-content p').first().text() ||
      $('.synopsis').text() ||
      $('.description').text();

    return description ? description.trim().substring(0, 500) : null;
  } catch (error) {
    return null;
  }
}

async function parseEpisodesJs(url) {
  try {
    console.log(`🔍 Récupération: ${url}`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': CONFIG.userAgent,
        'Accept': 'text/javascript, application/javascript, */*; q=0.01',
        'Referer': CONFIG.baseUrl + '/'
      },
      timeout: 15000
    });

    const jsContent = response.data;
    const episodes = {};
    let playerCounter = 0;

    const episodeRegex = /var\s+(eps\d+)\s*=\s*\[(.*?)\];/gs;
    let match;

    while ((match = episodeRegex.exec(jsContent)) !== null) {
      try {
        const varName = match[1];
        const content = match[2];

        const episodeArray = content
          .split(',')
          .map(url => {
            let cleanUrl = url.trim().replace(/['"`]/g, '').trim();
            if (cleanUrl && cleanUrl.startsWith('http')) {
              return cleanUrl;
            }
            return null;
          })
          .filter(url => url && url.length > 5 && url.includes('http'));

        if (episodeArray.length === 0) continue;

        const firstUrl = episodeArray[0] || '';
        let playerType = 'Direct';

        for (const [key, value] of Object.entries(playerTypes)) {
          if (firstUrl.toLowerCase().includes(key.toLowerCase())) {
            playerType = value;
            break;
          }
        }

        const playerId = `player_${playerCounter++}`;

        const numberedEpisodes = episodeArray.map((url, index) => ({
          number: index + 1,
          url: url,
          embedUrl: url,
          type: 'video'
        }));

        episodes[playerId] = {
          playerName: playerType,
          playerKey: varName,
          episodes: numberedEpisodes,
          totalEpisodes: numberedEpisodes.length,
          firstUrl: firstUrl
        };

        console.log(`   ✅ ${playerType}: ${numberedEpisodes.length} épisodes trouvés`);
      } catch (error) {
        continue;
      }
    }

    if (Object.keys(episodes).length === 0) {
      console.log('   ⚠️ Aucun épisode trouvé dans le fichier');
    }

    return episodes;
  } catch (error) {
    console.error('❌ Erreur parsing episodes.js:', error.message);
    return {};
  }
}

async function scrapePageInfo(url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });

    const html = response.data;
    const thumbnail = await extractThumbnail(html);
    const description = await extractDescription(html);

    return {
      url: url,
      thumbnail,
      description,
      scraped: true,
      scrapedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      url: url,
      thumbnail: null,
      description: null,
      scraped: false,
      error: error.message
    };
  }
}

// ==================== FONCTIONS DE GESTION DES ANIMES ====================

async function loadAnimeList() {
  if (isInitialized && animeList.length > 0) {
    return true;
  }

  try {
    console.log('📥 Chargement de la liste des animes...');
    const response = await axios.get(ANIME_INFO_URL, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });

    let rawData = response.data;

    if (rawData.animes && Array.isArray(rawData.animes)) {
      animeList = rawData.animes
        .filter(anime => !anime.link || !anime.link.includes('/scan'))
        .map(anime => ({
          ...anime,
          title: anime.titre || anime.title,
          link: anime.url || anime.link,
          originalTitle: anime.titre || anime.title,
          type: 'anime'
        }));
    } else if (Array.isArray(rawData)) {
      animeList = rawData.filter(anime => !anime.link || !anime.link.includes('/scan'));
    } else {
      console.error('Format de données inconnu:', typeof rawData);
      animeList = [];
    }

    // Normalisation
    animeList.forEach(anime => {
      if (!anime.title && anime.titre) anime.title = anime.titre;
      if (!anime.link && anime.url) anime.link = anime.link || anime.url;
      anime.type = 'anime';
      
      const langMatch = anime.link?.match(/\/(vf|vostfr|va)\/?$/);
      if (langMatch) anime.language = langMatch[1];
    });

    isInitialized = true;
    console.log(`✅ Chargé ${animeList.length} animes depuis source`);
    return true;
  } catch (error) {
    console.error('❌ Erreur chargement:', error.message);
    animeList = [];
    return false;
  }
}

function findAnime(animeId) {
  if (!Array.isArray(animeList) || animeList.length === 0) {
    console.log('⚠️ animeList n\'est pas un tableau valide');
    return null;
  }

  const normalizedId = animeId.toLowerCase().trim();

  let anime = animeList.find(a =>
    a.title && (a.title.toLowerCase() === normalizedId ||
    normalizeSlug(a.title) === normalizedId)
  );

  if (!anime) {
    anime = animeList.find(a =>
      a.title && (a.title.toLowerCase().includes(normalizedId) ||
      normalizeSlug(a.title).includes(normalizedId))
    );
  }

  if (!anime) {
    anime = animeList.find(a => {
      if (!a.link) return false;
      const slugMatch = a.link.match(/catalogue\/([^\/]+)/);
      const slug = slugMatch ? slugMatch[1] : (a.title ? normalizeSlug(a.title) : '');
      return slug.includes(normalizedId);
    });
  }

  return anime;
}

// ==================== DÉTECTION DYNAMIQUE DES SAISONS ====================

async function detectAvailableSeasons(animeUrl, animeSlug, language) {
  try {
    const response = await axios.get(animeUrl, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const availableSeasons = [];

    $('a').each((index, element) => {
      const href = $(element).attr('href');
      if (!href) return;

      if (href.includes(`/catalogue/${animeSlug}/`)) {
        const afterSlug = href.split(`/catalogue/${animeSlug}/`)[1];
        if (afterSlug && !afterSlug.includes('/scan')) {
          const match = afterSlug.match(/^([^\/]+)\/(vf|vostfr|va)\/?/);
          if (match) {
            const typePattern = match[1];
            const lang = match[2];

            if (!language || lang === language) {
              const fullUrl = href.startsWith('http') ? href : CONFIG.baseUrl + href;
              availableSeasons.push({
                pattern: typePattern,
                type: typePattern.startsWith('saison') ? 'saison' : (typePattern === 'film' ? 'film' : (typePattern === 'oav' ? 'oav' : 'other')),
                language: lang,
                url: fullUrl
              });
            }
          }
        }
      }
    });

    const uniqueSeasons = [];
    const seen = new Set();
    for (const season of availableSeasons) {
      const key = `${season.pattern}-${season.language}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueSeasons.push(season);
      }
    }

    return uniqueSeasons;
  } catch (error) {
    console.error('Erreur détection saisons:', error);
    return [];
  }
}

// ==================== HANDLERS ====================

async function handleAnimeDetails(animeId, language = 'vostfr') {
  await loadAnimeList();

  const anime = findAnime(animeId);

  if (!anime || !anime.link) {
    return {
      success: false,
      error: 'Anime non trouvé',
      suggestions: Array.isArray(animeList) ? animeList.slice(0, 5).map(a => ({ title: a.title })) : []
    };
  }

  const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
  const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);

  const availableSeasons = await detectAvailableSeasons(anime.link, animeSlug, language);

  let pageInfo = { thumbnail: null, description: null, scraped: false };
  try {
    pageInfo = await scrapePageInfo(anime.link);
  } catch (error) {
    console.error('Erreur scraping:', error.message);
  }

  return {
    success: true,
    data: {
      id: animeSlug,
      title: anime.title,
      type: 'anime',
      availableSeasons: availableSeasons,
      thumbnail: pageInfo.thumbnail,
      description: pageInfo.description,
      scraped: pageInfo.scraped,
      language: language,
      slug: animeSlug
    }
  };
}

async function handleSeasonDetails(animeId, seasonPattern, language = 'vostfr') {
  await loadAnimeList();

  const anime = findAnime(animeId);

  if (!anime || !anime.link) {
    return { success: false, error: 'Anime non trouvé' };
  }

  const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
  const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);

  let seasonUrl = `${CONFIG.baseUrl}/catalogue/${animeSlug}/${seasonPattern}/${language}/`;

  let urlExists = await checkUrlExists(seasonUrl);
  if (!urlExists) {
    seasonUrl = seasonUrl.replace(/\/$/, '');
    urlExists = await checkUrlExists(seasonUrl);
  }

  if (!urlExists) {
    return { success: false, error: `Saison/film "${seasonPattern}" non disponible en ${language}` };
  }

  const episodesJsUrl = `${seasonUrl.replace(/\/$/, '')}/episodes.js`;
  const episodesData = await parseEpisodesJs(episodesJsUrl);

  if (Object.keys(episodesData).length === 0) {
    return { success: false, error: 'Aucun épisode disponible pour cette saison' };
  }

  const organizedEpisodes = {};
  const totalEpisodes = new Set();
  const allPlayers = [];

  Object.entries(episodesData).forEach(([playerId, playerData]) => {
    organizedEpisodes[playerData.playerName] = {
      player: playerData.playerName,
      playerKey: playerData.playerKey,
      episodes: playerData.episodes.map(ep => ({
        episode: ep.number,
        url: ep.url,
        embedUrl: ep.embedUrl,
        language: language.toUpperCase(),
        type: ep.type || 'video'
      })),
      totalEpisodes: playerData.totalEpisodes,
      firstUrl: playerData.firstUrl
    };

    allPlayers.push(playerData.playerName);
    playerData.episodes.forEach(ep => {
      totalEpisodes.add(ep.number);
    });
  });

  let seasonInfo = { thumbnail: null, description: null, scraped: false };
  try {
    seasonInfo = await scrapePageInfo(seasonUrl);
  } catch (error) {
    console.error('Erreur scraping saison:', error.message);
  }

  const sortedEpisodes = [...totalEpisodes].sort((a, b) => a - b);

  let contentType = 'saison';
  if (seasonPattern === 'film') contentType = 'film';
  else if (seasonPattern === 'oav') contentType = 'oav';
  else if (seasonPattern.startsWith('saison')) contentType = 'saison';

  return {
    success: true,
    data: {
      id: animeSlug,
      title: anime.title,
      contentType: contentType,
      actualType: contentType,
      actualLanguage: language,
      actualSeason: seasonPattern,
      seasonNumber: seasonPattern.match(/\d+/) ? parseInt(seasonPattern.match(/\d+/)[0]) : null,
      seasonSuffix: seasonPattern.includes('-') ? seasonPattern.split('-')[1] : null,
      thumbnail: seasonInfo.thumbnail,
      description: seasonInfo.description,
      scraped: seasonInfo.scraped,
      totalEpisodes: sortedEpisodes.length,
      episodesList: sortedEpisodes,
      availablePlayers: [...new Set(allPlayers)],
      episodes: organizedEpisodes,
      slug: animeSlug
    }
  };
}

// ==================== ENDPOINTS API ====================

// Pas de limite sur les endpoints - tout est retourné intégralement

app.get('/api/anime', async (req, res) => {
  try {
    await loadAnimeList();

    const type = req.query.type;
    const search = req.query.search;

    let result = [...animeList];

    if (type === 'anime') {
      result = result.filter(item => item.type === 'anime');
    }

    if (search && search.length >= 2) {
      result = result.filter(item =>
        item.title && item.title.toLowerCase().includes(search.toLowerCase())
      );
    }

    // Pas de limite - retourne tout
    res.json({
      success: true,
      count: result.length,
      total: result.length,
      type: type || 'all',
      data: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/anime/:id', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const language = req.query.lang || 'vostfr';

    const result = await handleAnimeDetails(animeId, language);

    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/anime/:id/saison/:season', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const seasonPattern = req.params.season;
    const language = req.query.lang || 'vostfr';

    const result = await handleSeasonDetails(animeId, seasonPattern, language);

    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/anime/:id/saison/:season/episode/:episode', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const seasonPattern = req.params.season;
    const episode = parseInt(req.params.episode);
    const language = req.query.lang || 'vostfr';
    const player = req.query.player;

    if (isNaN(episode) || episode < 1) {
      return res.status(400).json({ success: false, error: "Numéro d'épisode invalide" });
    }

    const seasonResult = await handleSeasonDetails(animeId, seasonPattern, language);

    if (!seasonResult.success) return res.status(404).json(seasonResult);

    const seasonData = seasonResult.data;
    const episodeOptions = [];

    Object.values(seasonData.episodes).forEach(playerData => {
      const episodeInfo = playerData.episodes.find(ep => ep.episode === episode);
      if (episodeInfo) {
        episodeOptions.push({
          player: playerData.player,
          playerKey: playerData.playerKey,
          episode,
          url: episodeInfo.url,
          embedUrl: episodeInfo.embedUrl,
          language: episodeInfo.language,
          type: episodeInfo.type || 'video'
        });
      }
    });

    if (episodeOptions.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Épisode ${episode} non disponible`,
        availableEpisodes: seasonData.episodesList
      });
    }

    let filteredOptions = episodeOptions;

    if (player) {
      filteredOptions = episodeOptions.filter(opt =>
        opt.player.toLowerCase().includes(player.toLowerCase()) ||
        opt.playerKey.toLowerCase().includes(player.toLowerCase())
      );

      if (filteredOptions.length === 0) {
        return res.status(404).json({
          success: false,
          error: `Épisode ${episode} non disponible avec le lecteur ${player}`,
          availablePlayers: [...new Set(episodeOptions.map(opt => opt.player))]
        });
      }
    }

    res.json({
      success: true,
      data: {
        anime: seasonData.title,
        season: seasonData.actualSeason,
        seasonNumber: seasonData.seasonNumber,
        seasonSuffix: seasonData.seasonSuffix,
        episode,
        thumbnail: seasonData.thumbnail,
        description: seasonData.description,
        language: language.toUpperCase(),
        totalOptions: filteredOptions.length,
        options: filteredOptions,
        allPlayers: [...new Set(episodeOptions.map(opt => opt.player))],
        request: {
          player: player || 'Tous',
          playerFilter: !!player,
          timestamp: new Date().toISOString()
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    await loadAnimeList();

    const query = req.query.q;
    const type = req.query.type;

    if (!query || query.length < 2) {
      return res.status(400).json({ success: false, error: 'Requête de recherche trop courte (min 2 caractères)' });
    }

    let searchResults = animeList.filter(item =>
      item.title && item.title.toLowerCase().includes(query.toLowerCase())
    );

    if (type === 'anime') {
      searchResults = searchResults.filter(item => item.type === 'anime');
    }

    // Pas de limite - retourne tout
    res.json({
      success: true,
      query,
      type: type || 'all',
      count: searchResults.length,
      total: searchResults.length,
      data: searchResults
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/proxy/stream', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    const referer = req.query.referer || CONFIG.baseUrl + '/';

    if (!videoUrl) {
      return res.status(400).json({ success: false, error: 'URL requise' });
    }

    const response = await axios.get(videoUrl, {
      responseType: 'stream',
      headers: {
        'Referer': referer,
        'User-Agent': CONFIG.userAgent,
        'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5'
      },
      timeout: 30000
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Content-Length': response.headers['content-length'],
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*'
    });

    response.data.pipe(res);
  } catch (error) {
    console.error('Erreur proxy streaming:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/direct/episodes', async (req, res) => {
  try {
    const url = req.query.url;

    if (!url) {
      return res.status(400).json({ success: false, error: 'URL requise' });
    }

    const episodesData = await parseEpisodesJs(url);

    if (Object.keys(episodesData).length === 0) {
      return res.status(404).json({ success: false, error: 'Aucun épisode trouvé' });
    }

    res.json({
      success: true,
      url,
      type: 'anime',
      players: Object.values(episodesData).map(p => p.playerName),
      totalEpisodes: Object.values(episodesData)[0]?.totalEpisodes || 0,
      data: episodesData
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test/url', async (req, res) => {
  try {
    const url = req.query.url;

    if (!url) {
      return res.status(400).json({ success: false, error: 'URL requise' });
    }

    const exists = await checkUrlExists(url);

    res.json({
      success: true,
      url,
      exists,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/players', (req, res) => {
  res.json({
    success: true,
    players: playerTypes,
    count: {
      players: Object.keys(playerTypes).length
    }
  });
});

app.get('/api/status', async (req, res) => {
  await loadAnimeList();

  const animesCount = Array.isArray(animeList) ? animeList.filter(a => a.type === 'anime').length : 0;

  res.json({
    success: true,
    server: {
      status: 'running',
      uptime: process.uptime(),
      totalCount: Array.isArray(animeList) ? animeList.length : 0,
      animesCount,
      timestamp: new Date().toISOString()
    },
    endpoints: {
      anime: {
        list: '/api/anime',
        details: '/api/anime/:id',
        season: '/api/anime/:id/saison/:season',
        episode: '/api/anime/:id/saison/:season/episode/:number'
      },
      common: {
        search: '/api/search',
        players: '/api/players',
        proxy: '/api/proxy/stream',
        status: '/api/status'
      }
    }
  });
});

// Route racine
app.get('/', (req, res) => {
  res.json({
    name: 'Anime API',
    version: '2.0.0',
    description: 'API pour anime',
    endpoints: {
      anime: {
        list: 'GET /api/anime',
        details: 'GET /api/anime/:id',
        seasons: 'GET /api/anime/:id/saison/:season',
        episode: 'GET /api/anime/:id/saison/:season/episode/:number'
      },
      search: 'GET /api/search?q=query',
      players: 'GET /api/players',
      proxy: 'GET /api/proxy/stream?url=video_url',
      status: 'GET /api/status'
    }
  });
});

// Middleware 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint non trouvé'
  });
});

// Export pour Vercel
module.exports = app;