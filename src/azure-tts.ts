// 微软 Edge TTS 免费语音代理 (azure-tts, 内置无需 API Key)
// 接收 OpenAI 兼容 POST /v1/audio/speech { model, input, voice?, rate?, volume?, pitch? }
// → 调用微软 Translator endpoint + cognitiveservices TTS (纯 HTTP, Workers 兼容) → audio/mpeg 流
// 移植自 one-api-cf (参考 linshenkx/edge-tts-openai-cf-worker)

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60 // 提前 5 分钟刷新 token
const ENDPOINT_URL = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0'
const MT_SIGNING_KEY_B64 = 'oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=='

let tokenInfo: { r: string; t: string; expiredAt: number } | null = null

const uuid = (): string => crypto.randomUUID().replace(/-/g, '')

const hmacSha256 = async (key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> => {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)))
}

const base64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const bytesToBase64 = (bytes: Uint8Array<ArrayBuffer>): string => btoa(String.fromCharCode(...bytes))

const dateFormat = (): string => new Date().toUTCString().replace(/GMT/, '').trim() + ' GMT'

// 生成 X-MT-Signature (MSTranslatorAndroidApp HMAC)
const sign = async (urlStr: string): Promise<string> => {
  const url = urlStr.split('://')[1]
  const encodedUrl = encodeURIComponent(url)
  const uuidStr = uuid()
  const d = dateFormat()
  const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${d}${uuidStr}`.toLowerCase()
  const key = base64ToBytes(MT_SIGNING_KEY_B64)
  const sig = await hmacSha256(key, bytesToSign)
  return `MSTranslatorAndroidApp::${bytesToBase64(sig)}::${d}::${uuidStr}`
}

// 获取 (并缓存) endpoint token
const getEndpoint = async (): Promise<{ r: string; t: string }> => {
  const now = Date.now() / 1000
  if (tokenInfo && tokenInfo.t && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
    return tokenInfo
  }

  const clientId = uuid()
  const response = await fetch(ENDPOINT_URL, {
    method: 'POST',
    headers: {
      'Accept-Language': 'zh-Hans',
      'X-ClientVersion': '4.0.530a 5fe1dc6c',
      'X-UserId': '0f04d16a175c411e',
      'X-HomeGeographicRegion': 'zh-Hans-CN',
      'X-ClientTraceId': clientId,
      'X-MT-Signature': await sign(ENDPOINT_URL),
      'User-Agent': 'okhttp/4.5.0',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': '0',
      'Accept-Encoding': 'gzip',
    },
  })

  if (!response.ok) {
    throw new Error(`Azure TTS: endpoint token failed (${response.status})`)
  }

  const data = (await response.json()) as { r?: string; t?: string }
  if (!data.t) {
    throw new Error('Azure TTS: endpoint token missing')
  }

  let expiredAt = now + 3600
  try {
    const payload = JSON.parse(atob(data.t.split('.')[1]))
    if (typeof payload.exp === 'number') expiredAt = payload.exp
  } catch { /* ignore */ }

  tokenInfo = { r: data.r || 'eastus', t: data.t, expiredAt }
  return tokenInfo
}

const buildSsml = (text: string, voice: string, rate: string, volume: string, pitch: string): string => {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const locale = voice.split('-').slice(0, 2).join('-')
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="${locale}">
    <voice name="${voice}">
        <prosody rate="${rate}" pitch="${pitch}" volume="${volume}">
            ${escaped}
        </prosody>
    </voice>
</speak>`
}

const normalizeRate = (v?: string): string => {
  const s = (v || '').trim()
  if (!s) return '+0%'
  return /^[+-]?\d+%$/.test(s) || /^[+-]?\d+(\.\d+)?x$/.test(s) ? s : '+0%'
}
const normalizeVolume = (v?: string): string => {
  const s = (v || '').trim()
  return /^[+-]?\d+%$/.test(s) ? s : '+0%'
}
const normalizePitch = (v?: string): string => {
  const s = (v || '').trim()
  return /^[+-]?\d+(Hz|%)$/.test(s) ? s : '+0Hz'
}

/** 核心: HTTP 合成语音, 返回 MP3 Uint8Array */
export const synthesizeAzureTts = async (
  text: string,
  options: { voice?: string; rate?: string; volume?: string; pitch?: string } = {},
  timeoutMs = 30000
): Promise<{ audio: Uint8Array; usedVoice: string }> => {
  const voice = options.voice || DEFAULT_VOICE
  const rate = normalizeRate(options.rate)
  const volume = normalizeVolume(options.volume)
  const pitch = normalizePitch(options.pitch)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const endpoint = await getEndpoint()
    const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`
    const ssml = buildSsml(text, voice, rate, volume, pitch)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': endpoint.t,
        'Content-Type': 'application/ssml+xml',
        'User-Agent': 'okhttp/4.5.0',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 300)
      throw new Error(`Azure TTS: upstream ${response.status} - ${errorText}`)
    }

    const buffer = await response.arrayBuffer()
    return { audio: new Uint8Array(buffer), usedVoice: voice }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('Azure TTS: synthesis timeout')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** OpenAI 兼容 handler: POST /v1/audio/speech */
export async function handleAzureTtsSpeech(body: any): Promise<Response> {
  try {
    const input = typeof body?.input === 'string' ? body.input.trim() : ''
    if (!input) {
      return new Response(JSON.stringify({ error: { message: 'Azure TTS: input text is required', type: 'invalid_request_error' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 参数优先级: 请求体 > 默认值
    const voice = (typeof body?.voice === 'string' && body.voice.trim()) ? body.voice.trim() : DEFAULT_VOICE
    const rate = (typeof body?.rate === 'string' && body.rate.trim()) ? body.rate.trim() : '+0%'
    const volume = (typeof body?.volume === 'string' && body.volume.trim()) ? body.volume.trim() : '+0%'
    const pitch = (typeof body?.pitch === 'string' && body.pitch.trim()) ? body.pitch.trim() : '+0Hz'

    const { audio, usedVoice } = await synthesizeAzureTts(input, { voice, rate, volume, pitch })

    return new Response(audio.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.byteLength),
        'X-Azure-TTS-Voice': usedVoice,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[azure-tts]', message)
    return new Response(JSON.stringify({ error: { message, type: 'azure_tts_error' } }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/** 音色语言分组（中文标注） */
export function azureVoiceGroup(id: string): string {
  if (id.startsWith('zh-CN')) return '中文'
  if (id.startsWith('zh-HK') || id.startsWith('zh-TW')) return '粤语/繁体'
  if (id.startsWith('en-')) return '英语'
  if (id.startsWith('ja-')) return '日语'
  if (id.startsWith('ko-')) return '韩语'
  if (id.startsWith('fr-')) return '法语'
  if (id.startsWith('de-')) return '德语'
  if (id.startsWith('ru-')) return '俄语'
  if (id.startsWith('es-')) return '西班牙语'
  if (id.startsWith('it-')) return '意大利语'
  if (id.startsWith('pt-')) return '葡萄牙语'
  return '其他'
}

/** 完整音色清单（移植自 ai-gateway-edgeone / edge-tts，154 个主流语言音色，label 为中文标注） */
export interface AzureVoice { id: string; label: string; group?: string }
export const AZURE_TTS_VOICES: AzureVoice[] = [
  // 中文(简体)
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓(女·温暖)' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊(女·可爱)' },
  { id: 'zh-CN-YunjianNeural', label: '云健(男·沉稳)' },
  { id: 'zh-CN-YunxiNeural', label: '云希(男·阳光)' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏(男童·清脆)' },
  { id: 'zh-CN-YunyangNeural', label: '云扬(男·新闻)' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北(女·东北)' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮(女·陕西)' },
  { id: 'zh-CN-YunfengNeural', label: '云峰(男·标准)' },
  { id: 'zh-CN-YunhaoNeural', label: '云皓(男·广告)' },
  { id: 'zh-CN-YunjieNeural', label: '云杰(男·活力)' },
  { id: 'zh-CN-YunzeNeural', label: '云泽(男·解说)' },
  { id: 'zh-CN-YunfanNeural', label: '云帆(男·旁白)' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰(女·欢快)' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵(女·温柔)' },
  { id: 'zh-CN-XiaomengNeural', label: '晓梦(女·甜美)' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨(女·播音)' },
  { id: 'zh-CN-XiaoqiuNeural', label: '晓秋(女·自然)' },
  { id: 'zh-CN-XiaoruiNeural', label: '晓睿(女·童声)' },
  { id: 'zh-CN-XiaoshuangNeural', label: '晓双(女·童声)' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱(女·学术)' },
  { id: 'zh-CN-XiaoyanNeural', label: '晓颜(女·训练)' },
  { id: 'zh-CN-XiaoyouNeural', label: '晓悠(女·童声)' },
  { id: 'zh-CN-XiaozhenNeural', label: '晓甄(女·温柔)' },
  { id: 'zh-CN-YunxiMultilingualNeural', label: '云希(多语言)' },
  { id: 'zh-CN-XiaoxiaoMultilingualNeural', label: '晓晓(多语言)' },
  // 中文(繁体/粤语/台湾)
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳(粤语·女)' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼(粤语·女)' },
  { id: 'zh-HK-WanLungNeural', label: '雲龍(粤语·男)' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻(台语·女)' },
  { id: 'zh-TW-HsiaoYuNeural', label: '曉雨(台语·女)' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲(台语·男)' },
  // 英文(美国)
  { id: 'en-US-AriaNeural', label: 'Aria(女)' },
  { id: 'en-US-JennyNeural', label: 'Jenny(女)' },
  { id: 'en-US-MichelleNeural', label: 'Michelle(女)' },
  { id: 'en-US-AnaNeural', label: 'Ana(女·童声)' },
  { id: 'en-US-SaraNeural', label: 'Sara(女)' },
  { id: 'en-US-EmmaNeural', label: 'Emma(女)' },
  { id: 'en-US-AvaNeural', label: 'Ava(女)' },
  { id: 'en-US-GuyNeural', label: 'Guy(男)' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher(男)' },
  { id: 'en-US-EricNeural', label: 'Eric(男)' },
  { id: 'en-US-RogerNeural', label: 'Roger(男)' },
  { id: 'en-US-SteffanNeural', label: 'Steffan(男)' },
  { id: 'en-US-AndrewNeural', label: 'Andrew(男)' },
  { id: 'en-US-BrianNeural', label: 'Brian(男)' },
  { id: 'en-US-BrandonNeural', label: 'Brandon(男)' },
  { id: 'en-US-DavisNeural', label: 'Davis(男)' },
  { id: 'en-US-TonyNeural', label: 'Tony(男)' },
  { id: 'en-US-AIGenerate1Neural', label: 'AI Generate 1' },
  { id: 'en-US-AIGenerate2Neural', label: 'AI Generate 2' },
  { id: 'en-US-BlueNeural', label: 'Blue(男·歌唱)' },
  { id: 'en-US-JasonNeural', label: 'Jason(男)' },
  { id: 'en-US-NancyNeural', label: 'Nancy(女)' },
  { id: 'en-US-ClaraNeural', label: 'Clara(女)' },
  // 英文(英国/澳洲/其他)
  { id: 'en-GB-SoniaNeural', label: 'Sonia(英·女)' },
  { id: 'en-GB-LibbyNeural', label: 'Libby(英·女)' },
  { id: 'en-GB-MaisieNeural', label: 'Maisie(英·女)' },
  { id: 'en-GB-RyanNeural', label: 'Ryan(英·男)' },
  { id: 'en-GB-ThomasNeural', label: 'Thomas(英·男)' },
  { id: 'en-GB-OliverNeural', label: 'Oliver(英·男)' },
  { id: 'en-AU-NatashaNeural', label: 'Natasha(澳·女)' },
  { id: 'en-AU-WilliamNeural', label: 'William(澳·男)' },
  { id: 'en-AU-AnnetteNeural', label: 'Annette(澳·女)' },
  { id: 'en-AU-ElsieNeural', label: 'Elsie(澳·女)' },
  { id: 'en-AU-TimNeural', label: 'Tim(澳·男)' },
  { id: 'en-CA-ClaraNeural', label: 'Clara(加·女)' },
  { id: 'en-CA-LiamNeural', label: 'Liam(加·男)' },
  { id: 'en-IN-NeerjaNeural', label: 'Neerja(印·女)' },
  { id: 'en-IN-PrabhatNeural', label: 'Prabhat(印·男)' },
  // 日语
  { id: 'ja-JP-NanamiNeural', label: 'Nanami(女)' },
  { id: 'ja-JP-KeitaNeural', label: 'Keita(男)' },
  { id: 'ja-JP-AoiNeural', label: 'Aoi(女)' },
  { id: 'ja-JP-DaichiNeural', label: 'Daichi(男)' },
  { id: 'ja-JP-MayumiNeural', label: 'Mayumi(女)' },
  { id: 'ja-JP-NaokiNeural', label: 'Naoki(男)' },
  { id: 'ja-JP-ShioriNeural', label: 'Shiori(女)' },
  // 韩语
  { id: 'ko-KR-SunHiNeural', label: 'SunHi(女)' },
  { id: 'ko-KR-InJoonNeural', label: 'InJoon(男)' },
  { id: 'ko-KR-HyunsuNeural', label: 'Hyunsu(男)' },
  { id: 'ko-KR-JiMinNeural', label: 'JiMin(女)' },
  { id: 'ko-KR-SeoHyeonNeural', label: 'SeoHyeon(女)' },
  // 法语
  { id: 'fr-FR-DeniseNeural', label: 'Denise(女)' },
  { id: 'fr-FR-EliseNeural', label: 'Elise(女)' },
  { id: 'fr-FR-VivienneNeural', label: 'Vivienne(女)' },
  { id: 'fr-FR-HenriNeural', label: 'Henri(男)' },
  { id: 'fr-FR-RemyNeural', label: 'Remy(男)' },
  { id: 'fr-CA-SylvieNeural', label: 'Sylvie(加·女)' },
  { id: 'fr-CA-AntoineNeural', label: 'Antoine(加·男)' },
  // 德语
  { id: 'de-DE-KatjaNeural', label: 'Katja(女)' },
  { id: 'de-DE-LouisaNeural', label: 'Louisa(女)' },
  { id: 'de-DE-AmalaNeural', label: 'Amala(女)' },
  { id: 'de-DE-ConradNeural', label: 'Conrad(男)' },
  { id: 'de-DE-BerndNeural', label: 'Bernd(男)' },
  { id: 'de-DE-FlorianNeural', label: 'Florian(男)' },
  { id: 'de-DE-ChristophNeural', label: 'Christoph(男)' },
  { id: 'de-DE-GiselaNeural', label: 'Gisela(女)' },
  { id: 'de-DE-LeniNeural', label: 'Leni(女)' },
  { id: 'de-AT-IngridNeural', label: 'Ingrid(奥·女)' },
  { id: 'de-AT-JonasNeural', label: 'Jonas(奥·男)' },
  // 俄语
  { id: 'ru-RU-SvetlanaNeural', label: 'Svetlana(女)' },
  { id: 'ru-RU-DariyaNeural', label: 'Dariya(女)' },
  { id: 'ru-RU-DmitryNeural', label: 'Dmitry(男)' },
  { id: 'ru-RU-PavelNeural', label: 'Pavel(男)' },
  // 西班牙语
  { id: 'es-ES-ElviraNeural', label: 'Elvira(西·女)' },
  { id: 'es-ES-AlvaroNeural', label: 'Alvaro(西·男)' },
  { id: 'es-ES-AbrilNeural', label: 'Abril(西·女)' },
  { id: 'es-ES-ArnauNeural', label: 'Arnau(西·男)' },
  { id: 'es-MX-DaliaNeural', label: 'Dalia(墨·女)' },
  { id: 'es-MX-JorgeNeural', label: 'Jorge(墨·男)' },
  { id: 'es-AR-ElenaNeural', label: 'Elena(阿·女)' },
  { id: 'es-AR-TomasNeural', label: 'Tomas(阿·男)' },
  // 意大利语
  { id: 'it-IT-ElsaNeural', label: 'Elsa(女)' },
  { id: 'it-IT-IsabellaNeural', label: 'Isabella(女)' },
  { id: 'it-IT-DiegoNeural', label: 'Diego(男)' },
  { id: 'it-IT-BenignoNeural', label: 'Benigno(男)' },
  // 葡萄牙语
  { id: 'pt-BR-FranciscaNeural', label: 'Francisca(巴·女)' },
  { id: 'pt-BR-AntonioNeural', label: 'Antonio(巴·男)' },
  { id: 'pt-BR-ThalitaNeural', label: 'Thalita(巴·女)' },
  { id: 'pt-PT-RaquelNeural', label: 'Raquel(葡·女)' },
  { id: 'pt-PT-DuarteNeural', label: 'Duarte(葡·男)' },
  // 其他语言
  { id: 'ar-SA-ZariyahNeural', label: 'Zariyah(阿语·女)' },
  { id: 'ar-SA-HamedNeural', label: 'Hamed(阿语·男)' },
  { id: 'hi-IN-SwaraNeural', label: 'Swara(印地·女)' },
  { id: 'hi-IN-MadhurNeural', label: 'Madhur(印地·男)' },
  { id: 'id-ID-GadisNeural', label: 'Gadis(印尼·女)' },
  { id: 'id-ID-ArdiNeural', label: 'Ardi(印尼·男)' },
  { id: 'th-TH-PremwadeeNeural', label: 'Premwadee(泰·女)' },
  { id: 'th-TH-NiwatNeural', label: 'Niwat(泰·男)' },
  { id: 'vi-VN-HoaiMyNeural', label: 'HoaiMy(越·女)' },
  { id: 'vi-VN-NamMinhNeural', label: 'NamMinh(越·男)' },
  { id: 'tr-TR-EmelNeural', label: 'Emel(土·女)' },
  { id: 'tr-TR-AhmetNeural', label: 'Ahmet(土·男)' },
  { id: 'pl-PL-ZofiaNeural', label: 'Zofia(波·女)' },
  { id: 'pl-PL-MarekNeural', label: 'Marek(波·男)' },
  { id: 'nl-NL-ColetteNeural', label: 'Colette(荷·女)' },
  { id: 'nl-NL-FennaNeural', label: 'Fenna(荷·女)' },
  { id: 'nl-NL-MaartenNeural', label: 'Maarten(荷·男)' },
  { id: 'sv-SE-SofieNeural', label: 'Sofie(瑞·女)' },
  { id: 'sv-SE-MattiasNeural', label: 'Mattias(瑞·男)' },
  { id: 'uk-UA-PolinaNeural', label: 'Polina(乌·女)' },
  { id: 'uk-UA-OstapNeural', label: 'Ostap(乌·男)' },
  { id: 'cs-CZ-VlastaNeural', label: 'Vlasta(捷·女)' },
  { id: 'cs-CZ-AntoninNeural', label: 'Antonin(捷·男)' },
  { id: 'da-DK-ChristelNeural', label: 'Christel(丹·女)' },
  { id: 'da-DK-JeppeNeural', label: 'Jeppe(丹·男)' },
  { id: 'fi-FI-SelmaNeural', label: 'Selma(芬·女)' },
  { id: 'fi-FI-HarriNeural', label: 'Harri(芬·男)' },
  { id: 'el-GR-AthinaNeural', label: 'Athina(希·女)' },
  { id: 'el-GR-NestorasNeural', label: 'Nestoras(希·男)' },
  { id: 'he-IL-HilaNeural', label: 'Hila(希伯来·女)' },
  { id: 'he-IL-AvriNeural', label: 'Avri(希伯来·男)' },
  { id: 'nb-NO-PernilleNeural', label: 'Pernille(挪·女)' },
  { id: 'nb-NO-FinnNeural', label: 'Finn(挪·男)' },
]

/** 带分组与中文标注的音色清单（接口直接返回这个） */
export const AZURE_TTS_VOICES_GROUPED: Array<{ id: string; label: string; group: string }> =
  AZURE_TTS_VOICES.map((v) => ({ id: v.id, label: v.label, group: v.group || azureVoiceGroup(v.id) }));
