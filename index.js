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

// Configuration
const CONFIG = {
  oldDomains: ['anime-sama.tv', 'anime-sama.si'],
  currentDomain: 'anime-sama.to',
  mainDomain: 'anime-sama.to',
  baseUrl: 'https://anime-sama.to',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// AnimeInfo depuis GitHub
const ANIME_INFO_URL = 'https://raw.githubusercontent.com/afrinode-dev/ANIME-JSON/refs/heads/main/anime.json';

// Cache en mémoire
let animeList = [];
let isInitialized = false;

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

// Types de scans (pour l'affichage)
const scanTypes = {
  'scan': 'Scan Principal',
  'scan-manga': 'Manga',
  'scan-side-story': 'Side Story',
  'scan-ragnarok': 'Ragnarok',
  'scan-arise': 'Arise'
};

// ==================== FONCTIONS DE GESTION DU DOMAINE ====================

async function detectMainDomain() {
  console.log('🔍 Détection du domaine principal...');

  const portalUrl = 'https://anime-sama.pw';

  try {
    const response = await axios.get(portalUrl, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    let mainDomain = null;
    let mainDomainUrl = null;

    // Méthode 1: Rechercher le tableau "Statut des domaines"
    const domainPattern = /anime-sama\.[a-z]+/g;
    const foundDomains = new Map();

    $('td').each((i, element) => {
      const text = $(element).text().trim();
      const domainMatch = text.match(/anime-sama\.[a-z]+/);
      if (domainMatch) {
        const domain = domainMatch[0];
        const row = $(element).closest('tr');
        const rowText = row.text();
        const statusMatch = rowText.match(/\((\d{3})\)/);
        const statusCode = statusMatch ? parseInt(statusMatch[1]) : null;

        if (statusCode === 200 || statusCode === 302 || statusCode === 301) {
          if (!foundDomains.has(domain)) {
            foundDomains.set(domain, statusCode);
          }
        }
      }
    });

    // Méthode 2: Rechercher tous les liens contenant anime-sama
    $('a').each((i, element) => {
      const href = $(element).attr('href');
      if (href && href.includes('anime-sama')) {
        const domainMatch = href.match(/https?:\/\/([^\/]+)/);
        if (domainMatch) {
          const domain = domainMatch[1];
          if (!foundDomains.has(domain)) {
            foundDomains.set(domain, null);
          }
        }
      }
    });

    // Méthode 3: Chercher dans le texte "domaine principal"
    $('p, div, span').each((i, element) => {
      const text = $(element).text();
      if (text.includes('domaine principal') || text.includes('Nom de domaine principal')) {
        const domainMatch = text.match(/anime-sama\.[a-z]+/);
        if (domainMatch) {
          const domain = domainMatch[0];
          if (!foundDomains.has(domain)) {
            foundDomains.set(domain, 200);
          }
        }
      }
    });

    // Tester chaque domaine trouvé
    for (const [domain, statusFromTable] of foundDomains) {
      if (statusFromTable === 200) {
        mainDomain = domain;
        mainDomainUrl = `https://${domain}`;
        console.log(`✅ Domaine trouvé via tableau: ${domain}`);
        break;
      }

      try {
        const testUrl = `https://${domain}`;
        const testResponse = await axios.get(testUrl, {
          headers: { 'User-Agent': CONFIG.userAgent },
          timeout: 5000,
          maxRedirects: 5
        });

        const finalUrl = testResponse.request.res.responseUrl || testUrl;
        const finalDomainMatch = finalUrl.match(/https?:\/\/([^\/]+)/);
        const finalDomain = finalDomainMatch ? finalDomainMatch[1] : domain;

        if (testResponse.status === 200) {
          mainDomain = finalDomain;
          mainDomainUrl = finalUrl;
          console.log(`✅ Domaine actif trouvé: ${mainDomain}`);
          break;
        }
      } catch (error) {
        // Ignorer les erreurs
      }
    }

    // Fallback
    if (!mainDomain) {
      const fallbackDomains = ['anime-sama.to', 'anime-sama.si', 'anime-sama.tv'];
      for (const domain of fallbackDomains) {
        try {
          const testUrl = `https://${domain}`;
          const testResponse = await axios.get(testUrl, {
            headers: { 'User-Agent': CONFIG.userAgent },
            timeout: 5000,
            maxRedirects: 5
          });

          const finalUrl = testResponse.request.res.responseUrl || testUrl;
          const finalDomainMatch = finalUrl.match(/https?:\/\/([^\/]+)/);
          const finalDomain = finalDomainMatch ? finalDomainMatch[1] : domain;

          if (testResponse.status === 200 || testResponse.status === 302) {
            mainDomain = finalDomain;
            mainDomainUrl = finalUrl;
            console.log(`✅ Domaine de secours trouvé: ${mainDomain}`);
            break;
          }
        } catch (error) {
          continue;
        }
      }
    }

    if (!mainDomain) {
      mainDomain = CONFIG.currentDomain;
      mainDomainUrl = `https://${CONFIG.currentDomain}`;
      console.log(`⚠️ Aucun domaine trouvé, utilisation du domaine par défaut: ${mainDomain}`);
    }

    CONFIG.mainDomain = mainDomain;
    CONFIG.baseUrl = mainDomainUrl.startsWith('http') ? mainDomainUrl : `https://${mainDomain}`;

    console.log(`📌 Domaine principal configuré: ${CONFIG.mainDomain}`);
    return CONFIG.mainDomain;
  } catch (error) {
    console.error('❌ Erreur accès au portail:', error.message);
    CONFIG.mainDomain = CONFIG.currentDomain;
    CONFIG.baseUrl = `https://${CONFIG.mainDomain}`;
    return CONFIG.mainDomain;
  }
}

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
    console.log('📥 Chargement de la liste des animes depuis GitHub...');
    const response = await axios.get(ANIME_INFO_URL, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });

    let rawData = response.data;

    if (rawData.animes && Array.isArray(rawData.animes)) {
      animeList = rawData.animes.map(anime => ({
        ...anime,
        title: anime.titre || anime.title,
        link: anime.url || anime.link,
        originalTitle: anime.titre || anime.title
      }));
    } else if (Array.isArray(rawData)) {
      animeList = rawData;
    } else {
      console.error('Format de données inconnu:', typeof rawData);
      animeList = [];
    }

    // Normalisation et détection du type
    animeList.forEach(anime => {
      if (!anime.title && anime.titre) anime.title = anime.titre;
      if (!anime.link && anime.url) anime.link = anime.url;

      if (anime.link && anime.link.includes('/scan')) {
        anime.type = 'scan';
        // Extraire le pattern exact du scan (ex: scan_side_story, scan-modulo, etc.)
        const scanMatch = anime.link.match(/\/catalogue\/[^\/]+\/(scan(?:_[^\/]+|-[^\/]+)?)\//);
        if (scanMatch) {
          anime.scanPattern = scanMatch[1]; // e.g., 'scan', 'scan_side_story', 'scan-modulo'
          // Extraire le nom du scan sans le préfixe 'scan'
          const pattern = scanMatch[1];
          if (pattern === 'scan') {
            anime.scanName = 'main';
            anime.displayName = 'Scan Principal';
          } else if (pattern.startsWith('scan_')) {
            anime.scanName = pattern.substring(5); // after 'scan_'
            anime.displayName = scanTypes[`scan-${anime.scanName}`] || anime.scanName;
          } else if (pattern.startsWith('scan-')) {
            anime.scanName = pattern.substring(5); // after 'scan-'
            anime.displayName = scanTypes[`scan-${anime.scanName}`] || anime.scanName;
          } else {
            anime.scanName = pattern;
            anime.displayName = pattern;
          }
        }
        // Extraire la langue
        const langMatch = anime.link.match(/\/(vf|vostfr|va)\/?$/);
        if (langMatch) anime.language = langMatch[1];
      } else {
        anime.type = 'anime';
        // Extraire le pattern de saison/film/oav
        const seasonMatch = anime.link.match(/\/catalogue\/[^\/]+\/(saison\d+(?:-\d+)?|film|oav)\//);
        if (seasonMatch) {
          anime.seasonPattern = seasonMatch[1];
        }
        const langMatch = anime.link.match(/\/(vf|vostfr|va)\/?$/);
        if (langMatch) anime.language = langMatch[1];
      }
    });

    isInitialized = true;
    console.log(`✅ Chargé ${animeList.length} animes/scans depuis GitHub`);
    console.log(`   📊 Animes: ${animeList.filter(a => a.type === 'anime').length}`);
    console.log(`   📖 Scans: ${animeList.filter(a => a.type === 'scan').length}`);
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

// ==================== DÉTECTION DYNAMIQUE DES SAISONS ET SCANS ====================

async function detectAvailableSeasons(animeUrl, animeSlug, language) {
  try {
    const response = await axios.get(animeUrl, {
      headers: { 'User-Agent': CONFIG.userAgent },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const availableSeasons = [];

    // Recherche tous les liens qui pourraient être des saisons, films, OAV
    $('a').each((index, element) => {
      const href = $(element).attr('href');
      if (!href) return;

      // Vérifier si le lien pointe vers un contenu du même slug
      if (href.includes(`/catalogue/${animeSlug}/`)) {
        // Extraire le segment après le slug
        const afterSlug = href.split(`/catalogue/${animeSlug}/`)[1];
        if (afterSlug) {
          // Le segment peut être "saison3/vostfr/", "saison3-2/vf/", "film/vostfr/", "oav/vostfr/", etc.
          const match = afterSlug.match(/^([^\/]+)\/(vf|vostfr|va)\/?/);
          if (match) {
            const typePattern = match[1]; // e.g., saison3, saison3-2, film, oav
            const lang = match[2];

            // Ne garder que si la langue correspond (ou si pas de filtre)
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

    // Dédupliquer
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
      if (!href) return;

      if (href.includes(`/catalogue/${animeSlug}/`)) {
        const afterSlug = href.split(`/catalogue/${animeSlug}/`)[1];
        if (afterSlug && afterSlug.includes('/scan')) {
          // Pattern: scan/... , scan_xxx/... , scan-xxx/...
          const scanMatch = afterSlug.match(/^(scan(?:_[^\/]+|-[^\/]+)?)\/(vf|vostfr|va)\/?/);
          if (scanMatch) {
            const pattern = scanMatch[1]; // e.g., scan, scan_side_story, scan-modulo
            const lang = scanMatch[2];

            if (!language || lang === language) {
              const fullUrl = href.startsWith('http') ? href : CONFIG.baseUrl + href;
              // Extraire le nom du scan
              let scanName = 'main';
              let displayName = 'Scan Principal';
              if (pattern === 'scan') {
                scanName = 'main';
                displayName = 'Scan Principal';
              } else if (pattern.startsWith('scan_')) {
                scanName = pattern.substring(5);
                displayName = scanTypes[`scan-${scanName}`] || scanName;
              } else if (pattern.startsWith('scan-')) {
                scanName = pattern.substring(5);
                displayName = scanTypes[`scan-${scanName}`] || scanName;
              } else {
                scanName = pattern;
                displayName = pattern;
              }

              availableScans.push({
                pattern: pattern,
                scanName: scanName,
                displayName: displayName,
                language: lang,
                url: fullUrl
              });
            }
          }
        }
      }
    });

    // Dédupliquer
    const uniqueScans = [];
    const seen = new Set();
    for (const scan of availableScans) {
      const key = `${scan.pattern}-${scan.language}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueScans.push(scan);
      }
    }

    // Trier : scan principal en premier, puis les autres
    uniqueScans.sort((a, b) => {
      if (a.pattern === 'scan') return -1;
      if (b.pattern === 'scan') return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    return uniqueScans;
  } catch (error) {
    console.error('Erreur détection scans:', error);
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
      suggestions: Array.isArray(animeList) ? animeList.slice(0, 5).map(a => ({ title: a.title, type: a.type || 'anime' })) : []
    };
  }

  const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
  const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);

  const availableSeasons = await detectAvailableSeasons(anime.link, animeSlug, language);
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

async function handleSeasonDetails(animeId, seasonPattern, language = 'vostfr') {
  await loadAnimeList();

  const anime = findAnime(animeId);

  if (!anime || !anime.link) {
    return { success: false, error: 'Anime non trouvé' };
  }

  const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
  const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);

  // Construire l'URL de la saison/film/oav
  let seasonUrl = `${CONFIG.baseUrl}/catalogue/${animeSlug}/${seasonPattern}/${language}/`;

  // Vérifier si l'URL existe
  let urlExists = await checkUrlExists(seasonUrl);
  if (!urlExists) {
    // Essayer sans slash final
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

  // Déterminer le type de contenu (saison, film, oav)
  let contentType = 'saison';
  if (seasonPattern === 'film') contentType = 'film';
  else if (seasonPattern === 'oav') contentType = 'oav';
  else if (seasonPattern.startsWith('saison')) contentType = 'saison';

  return {
    success: true,
    data: {
      id: animeSlug,
      title: anime.title,
      originalLink: anime.link,
      contentType: contentType,
      actualType: contentType,
      actualLanguage: language,
      actualSeason: seasonPattern,
      seasonNumber: seasonPattern.match(/\d+/) ? parseInt(seasonPattern.match(/\d+/)[0]) : null,
      seasonSuffix: seasonPattern.includes('-') ? seasonPattern.split('-')[1] : null,
      links: {
        pageUrl: seasonUrl,
        episodesJs: episodesJsUrl,
        vostfr: `${CONFIG.baseUrl}/catalogue/${animeSlug}/${seasonPattern}/vostfr/`,
        vf: `${CONFIG.baseUrl}/catalogue/${animeSlug}/${seasonPattern}/vf/`
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

async function handleScanDetails(animeId, scanPattern, language = 'vostfr') {
  await loadAnimeList();

  const anime = findAnime(animeId);

  if (!anime || !anime.link) {
    return { success: false, error: 'Anime/Scan non trouvé' };
  }

  const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
  const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);

  // Construire l'URL du scan selon le pattern
  let scanUrl;
  if (scanPattern === 'main' || scanPattern === 'scan') {
    scanUrl = `${CONFIG.baseUrl}/catalogue/${animeSlug}/scan/${language}/`;
  } else {
    // Essayer d'abord avec underscore, puis avec tiret
    const patterns = [
      `scan_${scanPattern}`,
      `scan-${scanPattern}`,
      scanPattern // au cas où c'est déjà un pattern complet
    ];
    let found = false;
    for (const pattern of patterns) {
      const testUrl = `${CONFIG.baseUrl}/catalogue/${animeSlug}/${pattern}/${language}/`;
      if (await checkUrlExists(testUrl)) {
        scanUrl = testUrl;
        found = true;
        break;
      }
    }
    if (!found) {
      return { success: false, error: `Scan ${scanPattern} non disponible en ${language}` };
    }
  }

  const episodesJsUrl = `${scanUrl.replace(/\/$/, '')}/episodes.js`;
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
  const displayName = scanTypes[`scan-${scanPattern}`] || (scanPattern === 'scan' ? 'Scan Principal' : scanPattern);

  return {
    success: true,
    data: {
      id: animeSlug,
      title: anime.title,
      scanName: scanPattern,
      displayName: displayName,
      originalLink: anime.link,
      contentType: 'scan',
      actualType: 'scan',
      actualLanguage: language,
      links: {
        pageUrl: scanUrl,
        episodesJs: episodesJsUrl,
        vostfr: `${CONFIG.baseUrl}/catalogue/${animeSlug}/scan${scanPattern === 'main' ? '' : '_' + scanPattern}/vostfr/`,
        vf: `${CONFIG.baseUrl}/catalogue/${animeSlug}/scan${scanPattern === 'main' ? '' : '_' + scanPattern}/vf/`
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

// ==================== MIDDLEWARE DOMAINE ====================

app.use(async (req, res, next) => {
  if (!CONFIG.mainDomain) {
    await detectMainDomain();
  }
  next();
});

// ==================== ENDPOINTS API ====================

app.get('/api/domain/update', async (req, res) => {
  try {
    const oldDomain = CONFIG.mainDomain;
    const newDomain = await detectMainDomain();

    res.json({
      success: true,
      oldDomain,
      newDomain,
      baseUrl: CONFIG.baseUrl,
      updated: oldDomain !== newDomain,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/anime', async (req, res) => {
  try {
    await loadAnimeList();

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
        item.title && item.title.toLowerCase().includes(search.toLowerCase())
      );
    }

    const total = result.length;
    const totalPages = Math.ceil(total / limit);
    const paginatedResult = result.slice(offset, offset + limit);

    res.json({
      success: true,
      count: paginatedResult.length,
      total,
      page,
      totalPages,
      type: type || 'all',
      data: paginatedResult
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

// Note: :season peut être "saison3", "saison3-2", "film", "oav", etc.
app.get('/api/anime/:id/saison/:season', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const seasonPattern = req.params.season; // peut être "saison3", "saison3-2", "film", "oav"
    const language = req.query.lang || 'vostfr';

    const result = await handleSeasonDetails(animeId, seasonPattern, language);

    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Pour les scans, on utilise un paramètre "scan" qui peut être "main", "side_story", "ragnarok", etc.
app.get('/api/scan/:id', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const scanPattern = req.query.scan || 'main'; // main, side_story, ragnarok, etc.
    const language = req.query.lang || 'vostfr';

    const result = await handleScanDetails(animeId, scanPattern, language);

    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/anime/:id/scans', async (req, res) => {
  try {
    await loadAnimeList();

    const animeId = decodeURIComponent(req.params.id);
    const language = req.query.lang || 'vostfr';

    const anime = findAnime(animeId);

    if (!anime || !anime.link) {
      return res.status(404).json({ success: false, error: 'Anime non trouvé' });
    }

    const slugMatch = anime.link.match(/catalogue\/([^\/]+)/);
    const animeSlug = slugMatch ? slugMatch[1] : normalizeSlug(anime.title);

    const availableScans = await detectAvailableScans(anime.link, animeSlug, language);

    res.json({
      success: true,
      data: {
        id: animeSlug,
        title: anime.title,
        availableScans,
        totalScans: availableScans.length,
        language
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/scans', async (req, res) => {
  try {
    await loadAnimeList();

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
        scan.title && scan.title.toLowerCase().includes(search.toLowerCase())
      );
    }

    // Grouper par slug (titre sans langue)
    const groupedScans = {};
    scans.forEach(scan => {
      const baseTitle = scan.title.replace(/ \(VF\)$| \(VOSTFR\)$| \(VA\)$/, '');
      const slug = normalizeSlug(baseTitle);
      if (!groupedScans[slug]) {
        groupedScans[slug] = {
          title: baseTitle,
          slug: slug,
          languages: [],
          scans: []
        };
      }
      if (!groupedScans[slug].languages.includes(scan.language)) {
        groupedScans[slug].languages.push(scan.language);
      }
      groupedScans[slug].scans.push({
        scanName: scan.scanName || 'main',
        displayName: scan.displayName || scanTypes[`scan-${scan.scanName}`] || 'Scan',
        language: scan.language,
        url: scan.link,
        pattern: scan.scanPattern
      });
    });

    const scanList = Object.values(groupedScans);
    const total = scanList.length;
    const totalPages = Math.ceil(total / limit);
    const paginatedResult = scanList.slice(offset, offset + limit);

    res.json({
      success: true,
      count: paginatedResult.length,
      total,
      page,
      totalPages,
      language: language || 'all',
      data: paginatedResult
    });
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

app.get('/api/scan/:id/chapitre/:chapter', async (req, res) => {
  try {
    const animeId = decodeURIComponent(req.params.id);
    const chapter = parseInt(req.params.chapter);
    const scanPattern = req.query.scan || 'main';
    const language = req.query.lang || 'vostfr';
    const volume = req.query.volume;

    if (isNaN(chapter) || chapter < 1) {
      return res.status(400).json({ success: false, error: 'Numéro de chapitre invalide' });
    }

    const scanResult = await handleScanDetails(animeId, scanPattern, language);

    if (!scanResult.success) return res.status(404).json(scanResult);

    const scanData = scanResult.data;
    const chapterOptions = [];

    Object.values(scanData.volumes).forEach(volumeData => {
      const chapterInfo = volumeData.chapters.find(ch => ch.chapter === chapter);
      if (chapterInfo && chapterInfo.url) {
        chapterOptions.push({
          volume: volumeData.volume,
          volumeName: volumeData.volumeName,
          chapter,
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

    if (volume) {
      filteredOptions = chapterOptions.filter(opt =>
        opt.volume.toLowerCase().includes(volume.toLowerCase())
      );

      if (filteredOptions.length === 0) {
        return res.status(404).json({
          success: false,
          error: `Chapitre ${chapter} non disponible dans le volume ${volume}`,
          availableVolumes: scanData.volumesList
        });
      }
    }

    res.json({
      success: true,
      data: {
        manga: scanData.title,
        scanName: scanData.scanName,
        displayName: scanData.displayName,
        chapter,
        thumbnail: scanData.thumbnail,
        description: scanData.description,
        language: language.toUpperCase(),
        totalOptions: filteredOptions.length,
        options: filteredOptions,
        allVolumes: scanData.volumesList,
        request: {
          volume: volume || 'Tous',
          volumeFilter: !!volume,
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
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const type = req.query.type;

    if (!query || query.length < 2) {
      return res.status(400).json({ success: false, error: 'Requête de recherche trop courte (min 2 caractères)' });
    }

    let searchResults = animeList.filter(item =>
      item.title && item.title.toLowerCase().includes(query.toLowerCase())
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
      query,
      type: type || 'all',
      count: paginatedResults.length,
      total,
      page,
      totalPages,
      data: paginatedResults
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
      return res.status(404).json({ success: false, error: 'Aucun épisode/chapitre trouvé' });
    }

    const firstPlayer = Object.values(episodesData)[0];
    const isScan = firstPlayer?.isScan || false;

    res.json({
      success: true,
      url,
      type: isScan ? 'scan' : 'anime',
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
    scanTypes,
    count: {
      players: Object.keys(playerTypes).length,
      scanTypes: Object.keys(scanTypes).length
    }
  });
});

app.get('/api/status', async (req, res) => {
  await loadAnimeList();

  const scansCount = Array.isArray(animeList) ? animeList.filter(a => a.type === 'scan').length : 0;
  const animesCount = Array.isArray(animeList) ? animeList.filter(a => a.type === 'anime').length : 0;

  res.json({
    success: true,
    server: {
      status: 'running',
      uptime: process.uptime(),
      totalCount: Array.isArray(animeList) ? animeList.length : 0,
      animesCount,
      scansCount,
      timestamp: new Date().toISOString()
    },
    domain: {
      current: CONFIG.mainDomain,
      baseUrl: CONFIG.baseUrl
    },
    endpoints: {
      anime: {
        list: '/api/anime',
        details: '/api/anime/:id',
        season: '/api/anime/:id/saison/:season',
        episode: '/api/anime/:id/saison/:season/episode/:number'
      },
      scan: {
        list: '/api/scans',
        details: '/api/scan/:id',
        chapter: '/api/scan/:id/chapitre/:number'
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

// Route racine - Page de documentation API
app.get('/', (req, res) => {
  try {
    const htmlPath = path.resolve(__dirname, 'api.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).json({ error: 'api.html introuvable', detail: e.message });
  }
});

// Middleware 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint non trouvé',
    documentation: '/'
  });
});

// Export pour Vercel (PAS de app.listen)
module.exports = app;