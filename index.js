const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
  oldDomains: ['anime-sama.tv', 'anime-sama.si'],
  currentDomain: 'anime-sama.to',
  mainDomain: null,
  baseUrl: null,
  domainCheckInterval: 24 * 60 * 60 * 1000,
  lastDomainCheck: null,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// AnimeInfo depuis GitHub
const ANIME_INFO_URL = 'https://raw.githubusercontent.com/afrinode-dev/ANIME-JSON/refs/heads/main/anime.json';

// Liste des animes
let animeList = [];

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

// Types de scans
const scanTypes = {
  'scan': 'Scan Principal',
  'scan-manga': 'Manga',
  'scan-side-story': 'Side Story',
  'scan-ragnarok': 'Ragnarok',
  'scan-arise': 'Arise'
};

// ==================== FONCTIONS DE GESTION DU DOMAINE ====================

/**
 * Détecte le domaine principal d'Anime Sama depuis anime-sama.pw
 */
async function detectMainDomain() {
  console.log('🔍 Détection du domaine principal depuis anime-sama.pw...');
  
  const portalUrl = 'https://anime-sama.pw';
  
  try {
    const response = await axios.get(portalUrl, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });
    
    const $ = cheerio.load(response.data);
    let mainDomain = null;
    let mainDomainUrl = null;
    
    // Recherche des liens
    $('a').each((i, element) => {
      const text = $(element).text().trim();
      const href = $(element).attr('href');
      
      if ((text.includes('ACCÉDER À ANIME-SAMA') || 
           text.includes('Accéder à Anime Sama')) && 
          href && href.includes('anime-sama')) {
        
        const domainMatch = href.match(/https?:\/\/([^\/]+)/);
        if (domainMatch) {
          mainDomain = domainMatch[1];
          mainDomainUrl = href;
        }
      }
    });
    
    if (mainDomain) {
      CONFIG.mainDomain = mainDomain;
      CONFIG.baseUrl = mainDomainUrl.startsWith('http') ? mainDomainUrl : `https://${mainDomain}`;
      console.log(`✅ Domaine principal détecté: ${CONFIG.mainDomain}`);
    } else {
      // Fallback
      const potentialDomains = ['https://anime-sama.tv', 'https://anime-sama.eu', 'https://anime-sama.si'];
      
      for (const domain of potentialDomains) {
        try {
          const testResponse = await axios.get(domain, {
            headers: { 'User-Agent': CONFIG.userAgent },
            timeout: 5000
          });
          
          if (testResponse.status === 200) {
            CONFIG.mainDomain = domain.replace('https://', '');
            CONFIG.baseUrl = domain;
            console.log(`✅ Domaine de secours trouvé: ${CONFIG.mainDomain}`);
            break;
          }
        } catch (error) {
          continue;
        }
      }
      
      if (!CONFIG.mainDomain) {
        CONFIG.mainDomain = CONFIG.currentDomain;
        CONFIG.baseUrl = `https://${CONFIG.mainDomain}`;
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur accès au portail:', error.message);
    CONFIG.mainDomain = CONFIG.currentDomain;
    CONFIG.baseUrl = `https://${CONFIG.mainDomain}`;
  }
  
  CONFIG.lastDomainCheck = Date.now();
  return CONFIG.mainDomain;
}

// ==================== FONCTIONS DE PARSING ====================

/**
 * Normalise un slug
 */
function normalizeSlug(title) {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Vérifie si une URL existe
 */
async function checkUrlExists(url) {
  try {
    const response = await axios.head(url, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 5000
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

/**
 * Extrait la thumbnail d'une page
 */
async function extractThumbnail(html, pageUrl) {
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

/**
 * Extrait la description d'une page
 */
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

/**
 * Parse un fichier episodes.js
 */
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
    
    // Regex pour les tableaux d'épisodes
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
        let playerType = 'Scan';
        
        if (!firstUrl.includes('drive.google.com')) {
          for (const [key, value] of Object.entries(playerTypes)) {
            if (firstUrl.toLowerCase().includes(key.toLowerCase())) {
              playerType = value;
              break;
            }
          }
        }
        
        const playerId = `player_${playerCounter++}`;
        
        const numberedEpisodes = episodeArray.map((url, index) => ({
          number: index + 1,
          url: url,
          player: playerType,
          embedUrl: url,
          type: url.includes('drive.google.com') ? 'image' : 'video'
        }));
        
        episodes[playerId] = {
          playerName: playerType,
          playerKey: varName,
          episodes: numberedEpisodes,
          totalEpisodes: numberedEpisodes.length,
          firstUrl: firstUrl,
          isScan: firstUrl.includes('drive.google.com')
        };
        
      } catch (error) {
        continue;
      }
    }
    
    return episodes;
  } catch (error) {
    console.error('❌ Erreur parsing episodes.js:', error.message);
    return {};
  }
}

/**
 * Scrape les informations complètes d'une page
 */
async function scrapePageInfo(url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });
    
    const html = response.data;
    const thumbnail = await extractThumbnail(html, url);
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

/**
 * Charge la liste des animes depuis GitHub
 */
async function loadAnimeList() {
  try {
    console.log('📥 Chargement de la liste des animes depuis GitHub...');
    const response = await axios.get(ANIME_INFO_URL, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });
    
    animeList = response.data;
    
    animeList.forEach(anime => {
      if (anime.link.includes('/scan')) {
        anime.type = 'scan';
        const scanMatch = anime.link.match(/catalogue\/([^\/]+)\/scan(?:-([^\/]+))?\/(vf|vostfr)/);
        if (scanMatch) {
          anime.scanSlug = scanMatch[1];
          anime.scanName = scanMatch[2] || 'main';
          anime.language = scanMatch[3];
        }
      } else {
        anime.type = 'anime';
      }
    });
    
    console.log(`✅ Chargé ${animeList.length} animes/scans depuis GitHub`);
    return true;
  } catch (error) {
    console.error('❌ Erreur chargement AnimeInfo.json depuis GitHub:', error.message);
    return false;
  }
}

/**
 * Trouve un anime dans la liste
 */
function findAnime(animeId) {
  const normalizedId = animeId.toLowerCase().trim();
  
  let anime = animeList.find(a => 
    a.title.toLowerCase() === normalizedId ||
    normalizeSlug(a.title) === normalizedId
  );
  
  if (!anime) {
    anime = animeList.find(a => 
      a.title.toLowerCase().includes(normalizedId) ||
      normalizeSlug(a.title).includes(normalizedId)
    );
  }
  
  if (!anime) {
    anime = animeList.find(a => {
      const slugMatch = a.link.match(/catalogue\/([^\/]+)/);
      const slug = slugMatch ? slugMatch[1] : normalizeSlug(a.title);
      return slug.includes(normalizedId);
    });
  }
  
  return anime;
}

/**
 * Détecte les saisons disponibles
 */
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
      const text = $(element).text().toLowerCase();
      
      if (href && (href.includes(`/saison`) || text.includes('saison'))) {
        let fullUrl = href.startsWith('http') ? href : CONFIG.baseUrl + href;
        
        if (fullUrl.includes(animeSlug) || href.includes(`/catalogue/`)) {
          const seasonMatch = href.match(/saison(\d+)([a-z]*)/i) || 
                             href.match(/season[\s\-]?(\d+)([a-z]*)/i) ||
                             text.match(/saison[\s\-]?(\d+)([a-z]*)/i);
          
          if (seasonMatch) {
            const seasonNum = parseInt(seasonMatch[1]);
            const suffix = (seasonMatch[2] || '').toLowerCase();
            const fullName = `saison${seasonNum}${suffix}`;
            
            const langMatch = href.match(/\/(vf|vostfr)\//);
            const urlLang = langMatch ? langMatch[1] : null;
            
            availableSeasons.push({
              season: seasonNum,
              suffix: suffix,
              fullName: fullName,
              url: fullUrl,
              language: urlLang || language,
              type: 'anime'
            });
          }
        }
      }
    });
    
    const uniqueSeasons = [];
    const seen = new Set();
    
    availableSeasons.forEach(season => {
      const key = `${season.season}-${season.suffix}-${season.language}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueSeasons.push(season);
      }
    });
    
    uniqueSeasons.sort((a, b) => {
      if (a.season !== b.season) return a.season - b.season;
      if (a.suffix !== b.suffix) return a.suffix.localeCompare(b.suffix);
      return a.language.localeCompare(b.language);
    });
    
    return uniqueSeasons;
  } catch (error) {
    console.error('Erreur détection saisons:', error);
    return [];
  }
}

/**
 * Détecte les scans disponibles
 */
async function detectAvailableScans(animeUrl, animeSlug, language) {
  try {
    const response = await axios.get(animeUrl, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });
    
    const $ = cheerio.load(response.data);
    const availableScans = [];
    
    $('a').each((index, element) => {
      const href = $(element).attr('href');
      
      if (href && href.includes('/scan')) {
        let fullUrl = href.startsWith('http') ? href : CONFIG.baseUrl + href;
        
        if (fullUrl.includes(animeSlug) || href.includes(`/catalogue/`)) {
          const scanMatch = href.match(/scan(?:-([^\/]+))?\/(vf|vostfr)/);
          
          if (scanMatch) {
            const scanType = scanMatch[1] || 'main';
            const scanLang = scanMatch[2];
            
            if (!language || scanLang === language) {
              let scanName = scanType;
              let displayName = scanTypes[`scan-${scanType}`] || scanType;
              
              if (scanType === 'main') {
                scanName = 'scan';
                displayName = 'Scan Principal';
              }
              
              availableScans.push({
                scanType: scanType,
                scanName: scanName,
                displayName: displayName,
                url: fullUrl,
                language: scanLang,
                type: 'scan'
              });
            }
          }
        }
      }
    });
    
    const uniqueScans = [];
    const seen = new Set();
    
    availableScans.forEach(scan => {
      const key = `${scan.scanType}-${scan.language}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueScans.push(scan);
      }
    });
    
    uniqueScans.sort((a, b) => {
      if (a.scanType === 'main') return -1;
      if (b.scanType === 'main') return 1;
      return a.displayName.localeCompare(b.displayName);
    });
    
    return uniqueScans;
  } catch (error) {
    console.error('Erreur détection scans:', error);
    return [];
  }
}

// ==================== FONCTIONS PRINCIPALES POUR LES ENDPOINTS ====================

/**
 * Gère les détails d'un anime (saisons et scans)
 */
async function handleAnimeDetails(animeId, language = 'vostfr') {
  const anime = findAnime(animeId);
  
  if (!anime) {
    return { 
      success: false, 
      error: 'Anime non trouvé',
      suggestions: animeList
        .filter(a => a.title.toLowerCase().includes(animeId.toLowerCase().substring(0, 3)))
        .slice(0, 5)
        .map(a => ({ title: a.title, type: a.type || 'anime' }))
    };
  }
  
  const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
  const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);
  
  const availableSeasons = anime.type === 'anime' 
    ? await detectAvailableSeasons(anime.link, animeSlug, language)
    : [];
  
  const availableScans = await detectAvailableScans(anime.link, animeSlug, language);
  
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
      type: anime.type || 'anime',
      originalLink: anime.link,
      availableSeasons: availableSeasons,
      availableScans: availableScans,
      thumbnail: pageInfo.thumbnail,
      description: pageInfo.description,
      scraped: pageInfo.scraped,
      language: language,
      slug: animeSlug
    }
  };
}

/**
 * Gère les détails d'une saison
 */
async function handleSeasonDetails(animeId, season, language = 'vostfr') {
  const anime = findAnime(animeId);
  
  if (!anime) {
    return { success: false, error: 'Anime non trouvé' };
  }
  
  const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
  const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);
  
  const seasonMatch = season.toString().match(/(\d+)([a-z]*)/i);
  const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : parseInt(season);
  const seasonSuffix = (seasonMatch ? seasonMatch[2] : '').toLowerCase();
  const seasonName = `saison${seasonNumber}${seasonSuffix}`;
  
  let seasonUrl = `${CONFIG.baseUrl}/catalogue/${animeSlug}/${seasonName}/${language}/`;
  
  let urlExists = await checkUrlExists(seasonUrl);
  if (!urlExists) {
    seasonUrl = `${CONFIG.baseUrl}/catalogue/${animeSlug}/${seasonName}/${language}`;
    urlExists = await checkUrlExists(seasonUrl);
    
    if (!urlExists) {
      return { success: false, error: `Saison ${seasonName} non disponible en ${language}` };
    }
  }
  
  const episodesJsUrl = `${seasonUrl}/episodes.js`;
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
        player: ep.player,
        type: ep.type || 'video'
      })),
      totalEpisodes: playerData.totalEpisodes,
      firstUrl: playerData.firstUrl,
      isScan: playerData.isScan || false
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
  
  return {
    success: true,
    data: {
      id: animeSlug,
      title: anime.title,
      originalLink: anime.link,
      contentType: 'saison',
      actualType: 'saison',
      actualLanguage: language,
      actualSeason: seasonName,
      seasonNumber: seasonNumber,
      seasonSuffix: seasonSuffix,
      links: {
        pageUrl: seasonUrl,
        episodesJs: episodesJsUrl,
        vostfr: `${CONFIG.baseUrl}/catalogue/${animeSlug}/${seasonName}/vostfr/`,
        vf: `${CONFIG.baseUrl}/catalogue/${animeSlug}/${seasonName}/vf/`
      },
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

/**
 * Gère les détails d'un scan
 */
async function handleScanDetails(animeId, scanName = 'scan', language = 'vostfr') {
  const anime = findAnime(animeId);
  
  if (!anime) {
    return { success: false, error: 'Anime/Scan non trouvé' };
  }
  
  const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
  const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);
  
  let scanUrl;
  if (scanName === 'scan' || scanName === 'main') {
    scanUrl = `${CONFIG.baseUrl}/catalogue/${animeSlug}/scan/${language}/`;
  } else {
    scanUrl = `${CONFIG.baseUrl}/catalogue/${animeSlug}/scan-${scanName}/${language}/`;
  }
  
  let urlExists = await checkUrlExists(scanUrl);
  if (!urlExists) {
    scanUrl = scanUrl.replace(/\/$/, '');
    urlExists = await checkUrlExists(scanUrl);
    
    if (!urlExists) {
      return { success: false, error: `Scan ${scanName} non disponible en ${language}` };
    }
  }
  
  const episodesJsUrl = `${scanUrl}/episodes.js`;
  const chaptersData = await parseEpisodesJs(episodesJsUrl);
  
  if (Object.keys(chaptersData).length === 0) {
    return { success: false, error: 'Aucun chapitre disponible pour ce scan' };
  }
  
  const organizedChapters = {};
  const totalChapters = new Set();
  const allVolumes = [];
  
  Object.entries(chaptersData).forEach(([playerId, volumeData]) => {
    const volumeName = `Volume ${volumeData.playerKey.replace('eps', '')}`;
    organizedChapters[volumeData.playerKey] = {
      volume: volumeData.playerKey,
      volumeName: volumeName,
      chapters: volumeData.episodes.map(ch => ({
        chapter: ch.number,
        url: ch.url,
        type: ch.type || 'image',
        player: ch.player,
        placeholder: ch.placeholder || false
      })),
      totalChapters: volumeData.totalEpisodes,
      firstUrl: volumeData.firstUrl,
      isScan: volumeData.isScan || true
    };
    
    allVolumes.push(volumeData.playerKey);
    volumeData.episodes.forEach(ch => {
      if (!ch.placeholder) {
        totalChapters.add(ch.number);
      }
    });
  });
  
  let scanInfo = { thumbnail: null, description: null, scraped: false };
  try {
    scanInfo = await scrapePageInfo(scanUrl);
  } catch (error) {
    console.error('Erreur scraping scan:', error.message);
  }
  
  const sortedChapters = [...totalChapters].sort((a, b) => a - b);
  const displayName = scanTypes[`scan-${scanName}`] || (scanName === 'scan' ? 'Scan Principal' : scanName);
  
  return {
    success: true,
    data: {
      id: animeSlug,
      title: anime.title,
      scanName: scanName,
      displayName: displayName,
      originalLink: anime.link,
      contentType: 'scan',
      actualType: 'scan',
      actualLanguage: language,
      links: {
        pageUrl: scanUrl,
        episodesJs: episodesJsUrl,
        vostfr: `${CONFIG.baseUrl}/catalogue/${animeSlug}/scan${scanName === 'scan' ? '' : '-' + scanName}/vostfr/`,
        vf: `${CONFIG.baseUrl}/catalogue/${animeSlug}/scan${scanName === 'scan' ? '' : '-' + scanName}/vf/`
      },
      thumbnail: scanInfo.thumbnail,
      description: scanInfo.description,
      scraped: scanInfo.scraped,
      totalChapters: sortedChapters.length,
      totalVolumes: Object.keys(organizedChapters).length,
      chaptersList: sortedChapters,
      volumesList: allVolumes.sort((a, b) => {
        const numA = parseInt(a.replace('eps', ''));
        const numB = parseInt(b.replace('eps', ''));
        return numA - numB;
      }),
      volumes: organizedChapters,
      slug: animeSlug
    }
  };
}

// ==================== ENDPOINTS API ====================

// Endpoint pour vérifier/mettre à jour le domaine
app.get('/api/domain/update', async (req, res) => {
  try {
    const oldDomain = CONFIG.mainDomain;
    const newDomain = await detectMainDomain();
    
    res.json({
      success: true,
      oldDomain: oldDomain,
      newDomain: newDomain,
      baseUrl: CONFIG.baseUrl,
      updated: oldDomain !== newDomain,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API Endpoint pour la liste des animes
app.get('/api/anime', async (req, res) => {
  try {
    if (animeList.length === 0) {
      await loadAnimeList();
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const type = req.query.type;
    
    let result = [...animeList];
    
    if (type && ['anime', 'scan'].includes(type)) {
      result = result.filter(item => item.type === type);
    }
    
    const search = req.query.search;
    if (search && search.length >= 2) {
      result = result.filter(item => 
        item.title.toLowerCase().includes(search.toLowerCase())
      );
    }
    
    const total = result.length;
    const totalPages = Math.ceil(total / limit);
    const paginatedResult = result.slice(offset, offset + limit);
    
    const withThumbnails = req.query.thumbnails === 'true';
    let finalResult = paginatedResult;
    
    if (withThumbnails) {
      finalResult = await Promise.all(paginatedResult.map(async (item) => {
        try {
          const info = await scrapePageInfo(item.link);
          return { 
            ...item, 
            thumbnail: info.thumbnail,
            description: info.description ? info.description.substring(0, 200) : null
          };
        } catch (error) {
          return { ...item, thumbnail: null, description: null };
        }
      }));
    }
    
    res.json({
      success: true,
      count: finalResult.length,
      total: total,
      page: page,
      totalPages: totalPages,
      type: type || 'all',
      data: finalResult
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API Endpoint pour les détails d'un anime
app.get('/api/anime/:id', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const language = req.query.lang || 'vostfr';
    
    const result = await handleAnimeDetails(animeId, language);
    
    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.error,
        suggestions: result.suggestions || []
      });
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API Endpoint pour une saison spécifique
app.get('/api/anime/:id/saison/:season', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const season = req.params.season;
    const language = req.query.lang || 'vostfr';
    
    const result = await handleSeasonDetails(animeId, season, language);
    
    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.error
      });
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API Endpoint pour un scan spécifique
app.get('/api/scan/:id', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const scanName = req.query.scan || 'scan';
    const language = req.query.lang || 'vostfr';
    
    const result = await handleScanDetails(animeId, scanName, language);
    
    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.error
      });
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API Endpoint pour tous les scans d'un anime
app.get('/api/anime/:id/scans', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const language = req.query.lang || 'vostfr';
    
    const anime = findAnime(animeId);
    
    if (!anime) {
      return res.status(404).json({
        success: false,
        error: 'Anime non trouvé'
      });
    }
    
    const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
    const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);
    
    const availableScans = await detectAvailableScans(anime.link, animeSlug, language);
    
    const allScans = animeList.filter(item => 
      item.type === 'scan' && 
      item.scanSlug === animeSlug &&
      (!language || item.language === language)
    );
    
    const groupedScans = {};
    allScans.forEach(scan => {
      const key = scan.scanName;
      if (!groupedScans[key]) {
        groupedScans[key] = {
          scanName: scan.scanName,
          displayName: scanTypes[`scan-${scan.scanName}`] || (scan.scanName === 'main' ? 'Scan Principal' : scan.scanName),
          languages: [],
          urls: []
        };
      }
      
      if (!groupedScans[key].languages.includes(scan.language)) {
        groupedScans[key].languages.push(scan.language);
        groupedScans[key].urls.push({
          language: scan.language,
          url: scan.link
        });
      }
    });
    
    res.json({
      success: true,
      data: {
        id: animeSlug,
        title: anime.title,
        availableScans: availableScans,
        allScans: Object.values(groupedScans),
        totalScans: Object.keys(groupedScans).length,
        language: language
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API Endpoint pour lister tous les scans disponibles
app.get('/api/scans', async (req, res) => {
  try {
    if (animeList.length === 0) {
      await loadAnimeList();
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const language = req.query.lang;
    const search = req.query.search;
    
    let scans = animeList.filter(item => item.type === 'scan');
    
    if (language) {
      scans = scans.filter(scan => scan.language === language);
    }
    
    if (search && search.length >= 2) {
      scans = scans.filter(scan => 
        scan.title.toLowerCase().includes(search.toLowerCase()) ||
        (scan.scanSlug && scan.scanSlug.includes(search.toLowerCase()))
      );
    }
    
    const groupedScans = {};
    scans.forEach(scan => {
      if (!groupedScans[scan.scanSlug]) {
        groupedScans[scan.scanSlug] = {
          title: scan.title.replace(/ \(VF\)$| \(VOSTFR\)$/, ''),
          scanSlug: scan.scanSlug,
          languages: [],
          scans: []
        };
      }
      
      if (!groupedScans[scan.scanSlug].languages.includes(scan.language)) {
        groupedScans[scan.scanSlug].languages.push(scan.language);
      }
      
      groupedScans[scan.scanSlug].scans.push({
        scanName: scan.scanName,
        displayName: scanTypes[`scan-${scan.scanName}`] || (scan.scanName === 'main' ? 'Scan Principal' : scan.scanName),
        language: scan.language,
        url: scan.link,
        type: 'scan'
      });
    });
    
    const scanList = Object.values(groupedScans);
    const total = scanList.length;
    const totalPages = Math.ceil(total / limit);
    const paginatedResult = scanList.slice(offset, offset + limit);
    
    res.json({
      success: true,
      count: paginatedResult.length,
      total: total,
      page: page,
      totalPages: totalPages,
      language: language || 'all',
      data: paginatedResult
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour récupérer un épisode spécifique
app.get('/api/anime/:id/saison/:season/episode/:episode', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const season = req.params.season;
    const episode = parseInt(req.params.episode);
    const language = req.query.lang || 'vostfr';
    const player = req.query.player;
    
    if (isNaN(episode) || episode < 1) {
      return res.status(400).json({
        success: false,
        error: 'Numéro d\'épisode invalide'
      });
    }
    
    const seasonResult = await handleSeasonDetails(animeId, season, language);
    
    if (!seasonResult.success) {
      return res.status(404).json(seasonResult);
    }
    
    const seasonData = seasonResult.data;
    const episodeOptions = [];
    
    Object.values(seasonData.episodes).forEach(playerData => {
      const episodeInfo = playerData.episodes.find(ep => ep.episode === episode);
      if (episodeInfo) {
        episodeOptions.push({
          player: playerData.player,
          playerKey: playerData.playerKey,
          episode: episode,
          url: episodeInfo.url,
          embedUrl: episodeInfo.embedUrl,
          language: episodeInfo.language,
          playerType: episodeInfo.player,
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
    let playerFilterApplied = false;
    
    if (player) {
      filteredOptions = episodeOptions.filter(opt => 
        opt.player.toLowerCase().includes(player.toLowerCase()) ||
        opt.playerKey.toLowerCase().includes(player.toLowerCase())
      );
      playerFilterApplied = true;
    }
    
    if (filteredOptions.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Épisode ${episode} non disponible avec le lecteur ${player}`,
        availablePlayers: [...new Set(episodeOptions.map(opt => opt.player))]
      });
    }
    
    res.json({
      success: true,
      data: {
        anime: seasonData.title,
        season: seasonData.actualSeason,
        seasonNumber: seasonData.seasonNumber,
        seasonSuffix: seasonData.seasonSuffix,
        episode: episode,
        thumbnail: seasonData.thumbnail,
        description: seasonData.description,
        language: language.toUpperCase(),
        totalOptions: filteredOptions.length,
        options: filteredOptions,
        allPlayers: [...new Set(episodeOptions.map(opt => opt.player))],
        request: {
          player: player || 'Tous',
          playerFilter: playerFilterApplied,
          timestamp: new Date().toISOString()
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour récupérer un chapitre spécifique d'un scan
app.get('/api/scan/:id/chapitre/:chapter', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const chapter = parseInt(req.params.chapter);
    const scanName = req.query.scan || 'scan';
    const language = req.query.lang || 'vostfr';
    const volume = req.query.volume;
    
    if (isNaN(chapter) || chapter < 1) {
      return res.status(400).json({
        success: false,
        error: 'Numéro de chapitre invalide'
      });
    }
    
    const scanResult = await handleScanDetails(animeId, scanName, language);
    
    if (!scanResult.success) {
      return res.status(404).json(scanResult);
    }
    
    const scanData = scanResult.data;
    const chapterOptions = [];
    
    Object.values(scanData.volumes).forEach(volumeData => {
      const chapterInfo = volumeData.chapters.find(ch => ch.chapter === chapter);
      if (chapterInfo && chapterInfo.url) {
        chapterOptions.push({
          volume: volumeData.volume,
          volumeName: volumeData.volumeName,
          chapter: chapter,
          url: chapterInfo.url,
          type: chapterInfo.type || 'image',
          player: chapterInfo.player,
          placeholder: chapterInfo.placeholder || false
        });
      }
    });
    
    if (chapterOptions.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Chapitre ${chapter} non disponible`,
        availableChapters: scanData.chaptersList
      });
    }
    
    let filteredOptions = chapterOptions;
    let volumeFilterApplied = false;
    
    if (volume) {
      filteredOptions = chapterOptions.filter(opt => 
        opt.volume.toLowerCase().includes(volume.toLowerCase())
      );
      volumeFilterApplied = true;
    }
    
    if (filteredOptions.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Chapitre ${chapter} non disponible dans le volume ${volume}`,
        availableVolumes: scanData.volumesList
      });
    }
    
    res.json({
      success: true,
      data: {
        manga: scanData.title,
        scanName: scanData.scanName,
        displayName: scanData.displayName,
        chapter: chapter,
        thumbnail: scanData.thumbnail,
        description: scanData.description,
        language: language.toUpperCase(),
        totalOptions: filteredOptions.length,
        options: filteredOptions,
        allVolumes: scanData.volumesList,
        request: {
          volume: volume || 'Tous',
          volumeFilter: volumeFilterApplied,
          timestamp: new Date().toISOString()
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint recherche
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const type = req.query.type;
    
    if (!query || query.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Requête de recherche trop courte (min 2 caractères)'
      });
    }
    
    let searchResults = animeList.filter(item => 
      item.title.toLowerCase().includes(query.toLowerCase())
    );
    
    if (type && ['anime', 'scan'].includes(type)) {
      searchResults = searchResults.filter(item => item.type === type);
    }
    
    const total = searchResults.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const paginatedResults = searchResults.slice(offset, offset + limit);
    
    res.json({
      success: true,
      query: query,
      type: type || 'all',
      count: paginatedResults.length,
      total: total,
      page: page,
      totalPages: totalPages,
      data: paginatedResults
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint proxy streaming
app.get('/api/proxy/stream', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    const referer = req.query.referer || CONFIG.baseUrl + '/';
    
    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        error: 'URL requise'
      });
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour obtenir les infos directes d'une URL episodes.js
app.get('/api/direct/episodes', async (req, res) => {
  try {
    const url = req.query.url;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL requise'
      });
    }
    
    const episodesData = await parseEpisodesJs(url);
    
    if (Object.keys(episodesData).length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Aucun épisode/chapitre trouvé dans ce fichier'
      });
    }
    
    const firstPlayer = Object.values(episodesData)[0];
    const isScan = firstPlayer?.isScan || false;
    
    res.json({
      success: true,
      url: url,
      type: isScan ? 'scan' : 'anime',
      players: Object.values(episodesData).map(p => p.playerName),
      totalEpisodes: Object.values(episodesData)[0]?.totalEpisodes || 0,
      data: episodesData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour tester une URL
app.get('/api/test/url', async (req, res) => {
  try {
    const url = req.query.url;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL requise'
      });
    }
    
    const exists = await checkUrlExists(url);
    
    res.json({
      success: true,
      url: url,
      exists: exists,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint lecteurs
app.get('/api/players', (req, res) => {
  res.json({
    success: true,
    players: playerTypes,
    scanTypes: scanTypes,
    count: {
      players: Object.keys(playerTypes).length,
      scanTypes: Object.keys(scanTypes).length
    }
  });
});

// Endpoint statut
app.get('/api/status', async (req, res) => {
  const scansCount = animeList.filter(a => a.type === 'scan').length;
  const animesCount = animeList.filter(a => a.type === 'anime').length;
  
  res.json({
    success: true,
    server: {
      status: 'running',
      port: PORT,
      uptime: process.uptime(),
      totalCount: animeList.length,
      animesCount: animesCount,
      scansCount: scansCount,
      timestamp: new Date().toISOString()
    },
    domain: {
      current: CONFIG.mainDomain,
      baseUrl: CONFIG.baseUrl,
      lastCheck: CONFIG.lastDomainCheck ? new Date(CONFIG.lastDomainCheck).toISOString() : null
    },
    endpoints: {
      anime: {
        list: '/api/anime?page=1&limit=50&type=anime',
        details: '/api/anime/:id?lang=vostfr',
        season: '/api/anime/:id/saison/:season?lang=vostfr',
        episode: '/api/anime/:id/saison/:season/episode/:number?lang=vostfr'
      },
      scan: {
        list: '/api/scans?page=1&limit=50',
        details: '/api/scan/:id?scan=scanName&lang=vostfr',
        chapters: '/api/scan/:id/chapitres?scan=scanName',
        chapter: '/api/scan/:id/chapitre/:number?scan=scanName'
      },
      common: {
        search: '/api/search?q=query',
        players: '/api/players',
        proxy: '/api/proxy/stream?url=...',
        status: '/api/status'
      }
    }
  });
});

// Servir la documentation HTML
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/api.html');
});

app.get('/api.html', (req, res) => {
  res.sendFile(__dirname + '/api.html');
});

// Middleware pour les erreurs 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint non trouvé',
    documentation: '/'
  });
});

// ==================== INITIALISATION ====================

/**
 * Initialise le serveur
 */
async function initializeServer() {
  console.log('🚀 Initialisation du serveur...');
  
  await detectMainDomain();
  await loadAnimeList();
  
  app.listen(PORT, () => {
    console.log(`\n✅ Serveur API démarré sur http://localhost:${PORT}`);
    console.log(`🌐 Domaine principal: ${CONFIG.mainDomain}`);
    console.log(`📊 ${animeList.length} animes/scans chargés depuis GitHub`);
    console.log(`\n📡 Documentation: http://localhost:${PORT}/`);
  });
}

// Démarrer le serveur
initializeServer().catch(console.error);