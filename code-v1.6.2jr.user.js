// ==UserScript==
// @name         NAMCO Parks 改个人信息 *(通用版本)
// @namespace    https://parks2.bandainamco-am.co.jp/
// @version      1.6.0
// @description  改会员资料姓名/生日/性别；可隐藏按钮与券面强制显示；支持 Excel 复制快速填充
// @grant        unsafeWindow
// @author       park-tools
// @match        https://parks2.bandainamco-am.co.jp/*
// @icon         https://parks2.bandainamco-am.co.jp/client_info/BNAM_LBC_EC/view/userweb/favicon.ico
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  const ORIGIN = 'https://parks2.bandainamco-am.co.jp';
  const LS_KEY = 'namco_rename_draft_v1';
  const LS_OVERLAY = 'namco_ticket_overlay_v1';
  const LS_HIDE_UI = 'namco_hide_plugin_ui_v1';

  const TICKET_PATH_RE = /\/admission_(use_)?ticket\.html/i;
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function isLoggedInFromDom() {
    if (document.querySelector('a[href*="logoff"], a[href*="request=logoff"]')) return true;
    const html = document.documentElement.innerHTML;
    if (html.includes('ログアウト')) return true;
    return !!parseMemberData(html).member_id;
  }

  function htmlLooksLoggedIn(html) {
    if (!html) return false;
    if (html.includes('ログアウト')) return true;
    if (parseMemberData(html).member_id) return true;
    if (parseInput(html, 'PC_MAIL') && (parseInput(html, 'TEL') || parseInput(html, 'L_NAME'))) return true;
    return false;
  }

  /** iOS Tampermonkey 沙箱 fetch 不带 Cookie；结果放页面 window，避免把整页 HTML 塞进 DOM 属性被截断 */
  function pageFetch(url, options) {
    return new Promise((resolve, reject) => {
      const id = '__npFetch_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const opt = {
        method: (options && options.method) || 'GET',
        credentials: 'same-origin',
        redirect: 'follow',
        headers: (options && options.headers) || {},
      };
      if (options && options.body) opt.body = options.body;
      const win = PAGE;
      const script = document.createElement('script');
      script.textContent =
        '(function(){var id=' +
        JSON.stringify(id) +
        ';window[id]={p:1};fetch(' +
        JSON.stringify(url) +
        ',' +
        JSON.stringify(opt) +
        ').then(function(r){return r.text().then(function(t){window[id]={s:r.status,u:r.url,t:t};});}).catch(function(e){window[id]={e:String(e&&e.message||e)};});})();';
      document.documentElement.appendChild(script);
      script.remove();

      const start = Date.now();
      const timer = setInterval(() => {
        const box = (win && win[id]) || window[id];
        if (box && box.e) {
          clearInterval(timer);
          try { delete win[id]; } catch (e) { /* ignore */ }
          reject(new Error(box.e));
          return;
        }
        if (box && typeof box.t === 'string') {
          clearInterval(timer);
          const out = { status: Number(box.s || 0), url: box.u || url, text: box.t };
          try { delete win[id]; } catch (e) { /* ignore */ }
          resolve(out);
          return;
        }
        if (Date.now() - start > 90000) {
          clearInterval(timer);
          try { delete win[id]; } catch (e) { /* ignore */ }
          reject(new Error('请求超时'));
        }
      }, 40);
    });
  }

  async function httpGet(path, referer) {
    const url = path.startsWith('http') ? path : ORIGIN + path;
    const headers = { Referer: referer || ORIGIN + '/member_mypage.html' };
    try {
      return await pageFetch(url, { method: 'GET', headers });
    } catch (e1) {
      try {
        const r = await PAGE.fetch(url, { method: 'GET', credentials: 'include', headers });
        return { status: r.status, text: await r.text(), url: r.url };
      } catch (e2) {
        throw e1;
      }
    }
  }

  async function httpPost(path, body, referer) {
    const url = path.startsWith('http') ? path : ORIGIN + path;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: ORIGIN,
      Referer: referer || ORIGIN + '/member_regist.html?request=edit',
    };
    const bodyStr = new URLSearchParams(body).toString();
    try {
      return await pageFetch(url, { method: 'POST', headers, body: bodyStr });
    } catch (e1) {
      try {
        const r = await PAGE.fetch(url, { method: 'POST', credentials: 'include', headers, body: bodyStr });
        return { status: r.status, text: await r.text(), url: r.url };
      } catch (e2) {
        throw e1;
      }
    }
  }

  const store = {
    get(k, def) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, def);
      } catch (e) { /* ignore */ }
      try {
        const raw = localStorage.getItem(k);
        return raw == null ? def : JSON.parse(raw);
      } catch (e2) {
        return def;
      }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(k, v);
      } catch (e) { /* ignore */ }
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e2) { /* ignore */ }
    },
  };

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function escapeRe(name) {
    return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseInput(html, name) {
    const re = new RegExp(
      '<input\\b[^>]*\\bname=["\']' + escapeRe(name) + '["\'][^>]*>',
      'i'
    );
    const m = html.match(re);
    if (!m) return '';
    const v = m[0].match(/\bvalue=["']([^"']*)["']/i);
    return v ? v[1].trim() : '';
  }

  function parseSelected(html, name) {
    const sm = html.match(
      new RegExp('<select[^>]*name=["\']' + escapeRe(name) + '["\'][^>]*>([\\s\\S]*?)</select>', 'i')
    );
    if (!sm) return '';
    const opt = sm[1].match(/<option[^>]*\\bselected\\b[^>]*>/i) || sm[1].match(/<option[^>]*selected=["']selected["'][^>]*>/i);
    if (!opt) return '';
    const v = opt[0].match(/\\bvalue=["']([^"']*)["']/i);
    return v ? v[1].trim() : '';
  }

  function parseCheckedRadio(html, name) {
    const re = new RegExp(
      '<input\\b[^>]*\\bname=["\']' + escapeRe(name) + '["\'][^>]*>',
      'gi'
    );
    let m;
    while ((m = re.exec(html))) {
      const tag = m[0];
      if (!/\bchecked\b/i.test(tag)) continue;
      const v = tag.match(/\bvalue=["']([^"']*)["']/i);
      return v ? v[1] : '';
    }
    return '';
  }

  function parseFormChunk(html, formName) {
    const head = html.match(
      new RegExp('<form[^>]*name=["\']' + escapeRe(formName) + '["\'][^>]*>', 'i')
    );
    const body = html.match(
      new RegExp('<form[^>]*name=["\']' + escapeRe(formName) + '["\'][^>]*>([\\s\\S]*?)</form>', 'i')
    );
    let action = '';
    if (head) {
      const am = head[0].match(/\baction=["']([^"']+)/i);
      if (am) action = am[1];
    }
    return { action, chunk: body ? body[1] : '' };
  }

  function parseHiddenFields(chunk) {
    const fields = {};
    const re = /<input\b[^>]*>/gi;
    let m;
    while ((m = re.exec(chunk))) {
      const tag = m[0];
      if (!/type=["']hidden["']/i.test(tag) && !/type=["']checkbox["']/i.test(tag) && !/type=["']radio["']/i.test(tag)) {
        const nm = tag.match(/\bname=["']([^"']+)["']/i);
        const vm = tag.match(/\bvalue=["']([^"']*)["']/i);
        if (nm && !/^jp\.co\.interfactory\.framework\./i.test(nm[1])) {
          fields[nm[1]] = vm ? vm[1] : '';
        }
        continue;
      }
      const nm = tag.match(/\bname=["']([^"']+)["']/i);
      if (!nm) continue;
      const name = nm[1];
      if (/^jp\.co\.interfactory\.framework\./i.test(name)) continue;
      if (/type=["']checkbox["']/i.test(tag)) {
        if (/\bchecked\b/i.test(tag)) {
          const vm = tag.match(/\bvalue=["']([^"']*)["']/i);
          fields[name] = vm ? vm[1] : '1';
        }
        continue;
      }
      if (/type=["']radio["']/i.test(tag)) {
        if (/\bchecked\b/i.test(tag)) {
          const vm = tag.match(/\bvalue=["']([^"']*)["']/i);
          fields[name] = vm ? vm[1] : '';
        }
        continue;
      }
      const vm = tag.match(/\bvalue=["']([^"']*)["']/i);
      fields[name] = vm ? vm[1] : '';
    }
    const selRe = /<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
    let sm;
    while ((sm = selRe.exec(chunk))) {
      const name = sm[1];
      const opt = sm[2].match(/<option[^>]*\bselected\b[^>]*>/i);
      if (!opt) continue;
      const v = opt[0].match(/\bvalue=["']([^"']*)["']/i);
      fields[name] = v ? v[1] : '';
    }
    return fields;
  }

  function extractParksError(html) {
    const text = html || '';
    const pats = [
      /form-error-message[\s\S]*?<li>([^<]+)/i,
      /<li[^>]*>([^<]{4,200})<\/li>/i,
      /class="error[^"]*"[^>]*>([^<]+)/i,
      /errorMessage[^>]*>([^<]+)/i,
    ];
    for (let i = 0; i < pats.length; i++) {
      const m = text.match(pats[i]);
      if (m && m[1] && m[1].trim()) return m[1].replace(/\s+/g, ' ').trim();
    }
    if (text.includes('セッションがタイムアウト') || text.includes('セキュリティのため')) {
      return '会话超时，请刷新页面重新登录后再提交';
    }
    return '';
  }

  function looksExecuteSuccess(resp) {
    const t = (resp && resp.text) || '';
    const u = (resp && resp.url) || '';
    if (t.includes('会員情報を更新しました')) return true;
    if (t.includes('form-message') && t.includes('更新しました')) return true;
    if (u.includes('member_regist_confirm') && t.includes('更新')) return true;
    return false;
  }

  function parseToken(html) {
    const m = (html || '').match(/name="token"\s+value="([0-9a-f]+)"/i);
    return m ? m[1] : '';
  }

  function parseMemberData(html) {
    const m = (html || '').match(/var\s+member_data\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return {};
    try {
      return JSON.parse(m[1]);
    } catch (e) {
      return {};
    }
  }

  function parseProfile(html) {
    const md = parseMemberData(html);
    let tel = parseInput(html, 'TEL');
    if (!tel) {
     const tm = html.match(/(?:^|\D)(070\d{8}|080\d{8}|090\d{8})(?!\d)/);
     if (tm) tel = tm[1];
    }
    const y = parseInput(html, 'BIRTH_YEAR');
    const mo = parseInput(html, 'BIRTH_MONTH');
    const d = parseInput(html, 'BIRTH_DAY');
    let birthday = (md.birth || '').replace(/\//g, '-');
    if (y && mo && d) {
      birthday = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const sex = parseCheckedRadio(html, 'SEX') || (md.sex || 'M').toString().charAt(0).toUpperCase();
    return {
      email: parseInput(html, 'PC_MAIL'),
      last_name: parseInput(html, 'L_NAME'),
      first_name: parseInput(html, 'F_NAME'),
      last_name_kana: parseInput(html, 'L_KANA') || parseInput(html, 'L_NAME_KANA'),
      first_name_kana: parseInput(html, 'F_KANA') || parseInput(html, 'F_NAME_KANA'),
      nickname: parseInput(html, 'NICKNAME'),
      addr1: parseSelected(html, 'ADDR1') || parseInput(html, 'ADDR1') || '東京都',
      zip: (parseInput(html, 'ZIP') || '').replace(/-/g, ''),
      addr2: parseInput(html, 'ADDR2'),
      addr_street: parseInput(html, 'MEMBER.FREE_ITEM16'),
      addr3: parseInput(html, 'ADDR3'),
      tel,
      gender: sex === 'F' || sex === '2' ? 'F' : (sex === 'M' || sex === '1' ? 'M' : 'M'),
      birthday: birthday || '1990-01-01',
      formFields: parseHiddenFields(parseFormChunk(html, 'memberFrm').chunk || html),
    };
  }

  function splitFullName(full) {
    const s = String(full || '').trim().replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ');
    if (!s) return { l: '', f: '' };
    if (/^[A-Za-z]/.test(s)) {
      const parts = s.split(' ');
      if (parts.length >= 2) return { l: parts[0], f: parts.slice(1).join(' ') };
      return { l: s.charAt(0), f: s.slice(1) || s };
    }
    return { l: s.charAt(0), f: s.slice(1) };
  }

  function getOverlayConfig() {
    return store.get(LS_OVERLAY, { enabled: false, displayName: '' });
  }

  function setOverlayConfig(cfg) {
    store.set(LS_OVERLAY, cfg);
  }

  function getHideUi() {
    const saved = store.get(LS_HIDE_UI, null);
    if (saved != null) return saved;
    return { hidden: false };
  }

  function setHideUi(cfg) {
    store.set(LS_HIDE_UI, cfg);
  }

  function shouldHidePluginUi() {
    const cfg = getHideUi();
    return !!(cfg && cfg.hidden);
  }

  function buildDisplayName(l, f, full) {
    if (full && full.trim()) return full.trim().replace(/\s+/g, ' ');
    return `${l || ''} ${f || ''}`.trim();
  }

  function isTicketPage() {
    return TICKET_PATH_RE.test(location.pathname + location.search);
  }

  function getTicketNameDl() {
    const dls = document.querySelectorAll('dl.block-mypage-ticket-detail-code');
    for (let i = 0; i < dls.length; i++) {
      const dl = dls[i];
      if (dl.classList.contains('block-mypage-ticket-detail-code-margin-small')) continue;
      if (dl.querySelector('dd.block-mypage-ticket-detail-code-value')) return dl;
    }
    return null;
  }

  function injectOverlayStyles() {
    const css =
      'dd[data-np-overlay="1"],dd.np-injected-name{' +
      'display:block!important;visibility:visible!important;opacity:1!important;' +
      '-webkit-text-fill-color:currentColor!important}';
    let st = document.getElementById('np-overlay-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'np-overlay-style';
      document.head.appendChild(st);
    }
    st.textContent = css;
  }

  function ensureNameSlot() {
    const dl = getTicketNameDl();
    if (!dl) return null;
    let nameDd = null;
    dl.querySelectorAll('dd.block-mypage-coupon-list-item-code-value').forEach((dd) => {
      if (nameDd) return;
      const t = (dd.textContent || '').trim();
      if (!/^EC-\d/i.test(t) && !/^\d+$/.test(t)) nameDd = dd;
    });
    if (!nameDd) {
      nameDd = document.createElement('dd');
      nameDd.className = 'block-mypage-coupon-list-item-code-value np-injected-name';
      const ec = dl.querySelector('dd.block-mypage-ticket-detail-code-value');
      if (ec) dl.insertBefore(nameDd, ec);
      else dl.appendChild(nameDd);
    }
    return nameDd;
  }

  function findTicketNameNodes(scope, createIfMissing) {
    const root = scope || document;
    const nodes = [];
    const seen = new Set();
    if (createIfMissing) {
      const slot = ensureNameSlot();
      if (slot && !seen.has(slot)) {
        seen.add(slot);
        nodes.push(slot);
      }
    }
    root.querySelectorAll('dl.block-mypage-ticket-detail-code dd.block-mypage-coupon-list-item-code-value').forEach((dd) => {
      if (seen.has(dd)) return;
      const t = (dd.textContent || '').trim();
      if (/^EC-\d/i.test(t)) return;
      if (/^\d+$/.test(t)) return;
      seen.add(dd);
      nodes.push(dd);
    });
    return nodes;
  }

  function restoreTicketNames() {
    document.querySelectorAll('dd.np-injected-name').forEach((el) => el.remove());
    findTicketNameNodes(document, false).forEach((el) => {
      if (el.dataset.npOrig != null) {
        el.textContent = el.dataset.npOrig;
        delete el.dataset.npPatched;
        delete el.dataset.npOverlay;
      }
    });
  }

  function applyTicketOverlay(force) {
    const cfg = getOverlayConfig();
    if (!cfg.enabled || !cfg.displayName) {
      restoreTicketNames();
      return 0;
    }
    if (!isTicketPage() && !force) return 0;
    injectOverlayStyles();
    let n = 0;
    const nodes = findTicketNameNodes(document, true);
    nodes.forEach((el) => {
      const cur = (el.textContent || '').trim();
      if (el.dataset.npOrig == null && cur && cur !== cfg.displayName) {
        el.dataset.npOrig = cur;
      }
      if (cur !== cfg.displayName || el.dataset.npPatched !== '1') {
        el.textContent = cfg.displayName;
        el.dataset.npOverlay = '1';
        el.dataset.npPatched = '1';
        n += 1;
      }
    });
    return n;
  }

  function startOverlayWatcher() {
    if (window.__npOverlayWatcher) return;
    window.__npOverlayWatcher = true;

    const run = () => {
      if (!getOverlayConfig().enabled) return;
      applyTicketOverlay();
    };

    run();
    document.addEventListener('DOMContentLoaded', run);
    window.addEventListener('load', run);
    window.addEventListener('pageshow', run);

    const mo = new MutationObserver(() => {
      if (!getOverlayConfig().enabled) return;
      clearTimeout(window.__npOverlayTimer);
      window.__npOverlayTimer = setTimeout(run, 80);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(run, 100);
      }
    }, 500);
  }

  startOverlayWatcher();

  async function checkLoggedIn() {
    if (isLoggedInFromDom()) return true;
    try {
      const r = await httpGet('/member_mypage.html');
      return htmlLooksLoggedIn(r.text);
    } catch (e) {
      return isLoggedInFromDom();
    }
  }

  async function loadProfile() {
    await httpGet('/member_mypage.html');
    const r = await httpGet('/member_regist.html?request=edit');
    if (!htmlLooksLoggedIn(r.text)) {
      if (isLoggedInFromDom()) {
        throw new Error('已登录但读取资料失败，请刷新页面后重试');
      }
      throw new Error('未登录：请用 Safari 打开 parks2 并完成登录（不要用无痕模式）');
    }
    const p = parseProfile(r.text);
    if (!p.tel) throw new Error('未读取到手机号，无法安全提交');
    return p;
  }

  function normalizeBirthday(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const m1 = s.match(/^(\d{4})[-/\.](\d{1,2})[-/\.](\d{1,2})/);
    if (m1) {
      return `${m1[1]}-${String(parseInt(m1[2], 10)).padStart(2, '0')}-${String(parseInt(m1[3], 10)).padStart(2, '0')}`;
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length === 8) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
    return '';
  }

  function bdayParts(bday) {
    const norm = normalizeBirthday(bday) || '1990-01-01';
    const m = norm.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return { y: '1990', mo: '1', d: '1' };
    return {
      y: m[1],
      mo: String(parseInt(m[2], 10)),
      d: String(parseInt(m[3], 10)),
    };
  }

  async function updateMemberName(profile, changes, password) {
    const ln = changes.last_name || profile.last_name;
    const fn = changes.first_name || profile.first_name;
    const lk = changes.last_name_kana != null ? changes.last_name_kana : profile.last_name_kana;
    const fk = changes.first_name_kana != null ? changes.first_name_kana : profile.first_name_kana;
    const nick = changes.nickname != null ? changes.nickname : (profile.nickname || ln);
    const bday = normalizeBirthday(changes.birthday || profile.birthday) || profile.birthday || '1990-01-01';
    const { y, mo, d } = bdayParts(bday);
    const editRef = ORIGIN + '/member_regist.html?request=edit';
    const zip7 = String(profile.zip || '').replace(/-/g, '');
    const addr1 = profile.addr1 || '東京都';
    const addr2 = profile.addr2 || '';
    const addrStreet = profile.addr_street || '';
    const addr3 = profile.addr3 || '';
    const sex = changes.gender || profile.gender || 'M';
    if (!zip7 || !addr2 || !addrStreet) {
      throw new Error('当前资料缺邮编/市区町村/番地（官网已改为必填）。请先在「会員情報変更」填完整地址，再回来改名字。');
    }

    const confirm = Object.assign({}, profile.formFields || {}, {
      request: 'confirm',
      PC_MAIL_OLD: profile.email,
      FOREIGN_LOGIN_PROVIDER_KIND: '',
      MOBILE_MAIL_OLD: '',
      mode: '1',
      CART_MEMBER_REGIST: '',
      MAIL_FLG_OLD: '1',
      'SOCIAL_PLUS:SOCIAL_PLUS_ID': '',
      'SOCIAL_PLUS:PROVIDER': '',
      NICKNAME: nick,
      'jp.co.interfactory.framework.trim.NICKNAME': '',
      PC_MAIL: profile.email,
      'jp.co.interfactory.framework.trim.PC_MAIL': '',
      PASSWORD: password,
      PASSWORD2: password,
      BIRTH_YEAR: y,
      'jp.co.interfactory.framework.trim.BIRTH_YEAR': '',
      BIRTH_MONTH: mo,
      'jp.co.interfactory.framework.trim.BIRTH_MONTH': '',
      BIRTH_DAY: d,
      'jp.co.interfactory.framework.trim.BIRTH_DAY': '',
      SEX: sex,
      ZIP: zip7,
      'jp.co.interfactory.framework.trim.ZIP': '',
      ADDR1: addr1,
      ADDR2: addr2,
      'jp.co.interfactory.framework.trim.ADDR2': '',
      'MEMBER.FREE_ITEM16': addrStreet,
      'jp.co.interfactory.framework.trim.MEMBER.FREE_ITEM16': '',
      ADDR3: addr3,
      'jp.co.interfactory.framework.trim.ADDR3': '',
      TEL: profile.tel,
      'jp.co.interfactory.framework.trim.TEL': '',
      L_NAME: ln,
      F_NAME: fn,
      L_KANA: lk,
      'jp.co.interfactory.framework.trim.L_KANA': '',
      F_KANA: fk,
      'jp.co.interfactory.framework.trim.F_KANA': '',
      PC_MAIL_TYPE: '1',
      MOBILE_MAIL_TYPE: '1',
    });
    if (!addr3) confirm['MEMBER.FREE_ITEM19'] = '1';
    else delete confirm['MEMBER.FREE_ITEM19'];

    const r1 = await httpPost('/member_regist.html', confirm, editRef);
    if (r1.text.includes('sms_authentication') || r1.url.includes('sms_authentication')) {
      throw new Error('触发了 SMS 验证（请勿改手机号）');
    }
    const confirmParsed = parseFormChunk(r1.text, 'confirmForm');
    const hidden = parseHiddenFields(confirmParsed.chunk);
    const token = hidden.token || parseToken(r1.text);
    if (!token) {
      throw new Error(extractParksError(r1.text) || 'confirm 失败，请检查密码是否正确');
    }

    const execute = Object.assign({}, hidden, {
      request: 'execute',
      token,
      MAIL_FLG: hidden.MAIL_FLG || '1',
      BIRTH_YEAR: y,
      BIRTH_MONTH: mo,
      BIRTH_DAY: d,
      BIRTH: y + '/' + mo + '/' + d,
      SEX: sex,
      ZIP: zip7 || hidden.ZIP || '',
      ADDR1: addr1 || hidden.ADDR1 || '',
      ADDR2: addr2 || hidden.ADDR2 || '',
      'MEMBER.FREE_ITEM16': addrStreet || hidden['MEMBER.FREE_ITEM16'] || '',
      ADDR3: addr3 || hidden.ADDR3 || '',
      TEL: profile.tel,
      L_NAME: ln,
      F_NAME: fn,
      L_KANA: lk,
      F_KANA: fk,
      NICKNAME: nick,
      PC_MAIL: profile.email,
      PASSWORD: password,
      PASSWORD2: password,
    });
    if (addr3) delete execute['MEMBER.FREE_ITEM19'];
    else execute['MEMBER.FREE_ITEM19'] = '1';

    const action = confirmParsed.action || '/member_regist_confirm.html';
    const r2 = await httpPost(action, execute, ORIGIN + '/member_regist.html');
    if (r2.text.includes('sms_authentication') || r2.url.includes('sms_authentication')) {
      throw new Error('execute 触发 SMS');
    }
    if (!looksExecuteSuccess(r2)) {
      const afterEdit = await httpGet('/member_regist.html?request=edit', ORIGIN + '/member_mypage.html');
      const after = parseProfile(afterEdit.text);
      if (after.last_name === ln && after.first_name === fn) {
        return {
          last_name: ln,
          first_name: fn,
          last_name_kana: lk,
          first_name_kana: fk,
          birthday: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
          gender: sex,
        };
      }
      throw new Error(extractParksError(r2.text) || 'execute 未返回成功页');
    }
    return {
      last_name: ln,
      first_name: fn,
      last_name_kana: lk,
      first_name_kana: fk,
      birthday: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      gender: sex,
    };
  }

  async function verifyTicketNames() {
    const r = await httpGet('/admission_ticket.html');
    // const orders = [...r.text.matchAll(/admission_use_ticket\.html\?order_no=(\d+)/g)].map((m) => m[1]);
    // ✅ 修改为（兼容 iOS 15）：
    const orders = [];
    const orderRe = /admission_use_ticket\.html\?order_no=(\d+)/g;
    let om;
    while ((om = orderRe.exec(r.text)) !== null) {
      orders.push(om[1]);
    }
    
    const tickets = [];
    for (const ono of orders) {
      const t = await httpGet('/admission_use_ticket.html?order_no=' + ono, ORIGIN + '/admission_ticket.html');
      const m = t.text.match(
        /block-mypage-coupon-list-item-code-value">([^<]+)<\/dd>\s*<dd class="block-mypage-ticket-detail-code-value">(EC-\d+)<\/dd>/s
      );
      if (m) tickets.push({ order: ono, ec: m[2], name: m[1].trim() });
    }
    const hist = await httpGet('/member_history.html');
    // const clients = [...hist.text.matchAll(/ご依頼主<\/dt>\s*<dd[^>]*>\s*([^<]+)/g)].map((m) => m[1].trim());
    // ✅ 修改为（兼容 iOS 15）：
    const clients = [];
    const clientRe = /ご依頼主<\/dt>\s*<dd[^>]*>\s*([^<]+)/g;
    let cm;
    while ((cm = clientRe.exec(hist.text)) !== null) {
      clients.push(cm[1].trim());
    }
    const prof = await loadProfile();
    const member = `${prof.last_name} ${prof.first_name}`.trim();
    return { member, tickets, clients, kana: `${prof.last_name_kana} ${prof.first_name_kana}`.trim() };
  }

  /* ---------- UI ---------- */
  const css = `
#npRenameRoot{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}
#npRenameFab{position:fixed;right:14px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:2147483646;width:54px;height:54px;border-radius:27px;border:none;background:linear-gradient(135deg,#e60012,#b8000f);color:#fff;font-size:14px;font-weight:700;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer;}
#npRenameMask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483647;display:none;}
#npRenamePanel{position:fixed;left:0;right:0;bottom:0;max-height:88vh;overflow:auto;background:#fff;border-radius:16px 16px 0 0;padding:16px 16px calc(20px + env(safe-area-inset-bottom));z-index:2147483647;transform:translateY(110%);transition:transform .25s ease;box-sizing:border-box;}
#npRenamePanel.open{transform:translateY(0);}
#npRenamePanel *{box-sizing:border-box;font-family:inherit;}
.np-title{font-size:17px;font-weight:700;margin:0 0 4px;color:#111;}
.np-sub{font-size:12px;color:#666;margin:0 0 12px;line-height:1.5;}
.np-warn{font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:8px 10px;margin-bottom:12px;line-height:1.45;}
.np-row{margin-bottom:10px;}
.np-row label{display:block;font-size:12px;color:#444;margin-bottom:4px;}
.np-row input, .np-row select, .np-row textarea{width:100%;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:16px;background:#fff;}
.np-row input, .np-row select{height:42px;}
.np-row textarea{padding:8px 12px;font-size:14px;resize:vertical;}
.np-row input:focus, .np-row select:focus, .np-row textarea:focus{outline:none;border-color:#e60012;}
.np-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.np-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;}
.np-btn{height:44px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;}
.np-btn-primary{background:#e60012;color:#fff;}
.np-btn-secondary{background:#f3f4f6;color:#111;}
.np-btn-full{grid-column:1/-1;}
.np-log{margin-top:12px;font-size:12px;line-height:1.55;color:#333;background:#f9fafb;border-radius:8px;padding:10px;white-space:pre-wrap;max-height:160px;overflow:auto;}
.np-close{position:absolute;right:12px;top:12px;border:none;background:#eee;width:32px;height:32px;border-radius:16px;font-size:18px;cursor:pointer;}
.np-switch-box{background:linear-gradient(135deg,#ecfdf5,#f0fdf4);border:1px solid #6ee7b7;border-radius:12px;padding:12px;margin-bottom:12px;}
.np-switch-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;}
.np-switch-title{font-size:14px;font-weight:700;color:#065f46;}
.np-switch-hint{font-size:11px;color:#047857;line-height:1.45;margin:0 0 8px;}
.np-switch{position:relative;width:52px;height:30px;flex-shrink:0;}
.np-switch input{opacity:0;width:0;height:0;}
.np-switch-slider{position:absolute;inset:0;background:#cbd5e1;border-radius:15px;transition:.2s;cursor:pointer;}
.np-switch-slider:before{content:"";position:absolute;width:24px;height:24px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2);}
.np-switch input:checked+.np-switch-slider{background:#059669;}
.np-switch input:checked+.np-switch-slider:before{transform:translateX(22px);}
#npOverlayBadge{position:fixed;left:10px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:2147483645;background:#059669;color:#fff;font-size:11px;padding:6px 10px;border-radius:8px;display:none;max-width:42vw;line-height:1.3;box-shadow:0 2px 8px rgba(0,0,0,.25);}
`;

  const root = document.createElement('div');
  root.id = 'npRenameRoot';
  root.innerHTML = `
<style>${css}</style>
<button id="npRenameFab" type="button" title="改个人信息">改资料</button>
<div id="npRenameMask"></div>
<div id="npRenamePanel">
  <button class="np-close" type="button" id="npRenameClose">×</button>
  <p class="np-title">NAMCO Parks 改个人信息</p>
  <p class="np-sub">需已登录 parks2。改的是<strong>会员资料/会員情報変更</strong>中的姓名、生日与性别，无 SMS（手机号不变）。</p>
  <div class="np-warn">⚠ 「提交修改」改服务器会员资料（姓名/生日/性别）。官网编辑页生日/性别虽显示只读，接口可改。「券面强制显示」仅本机浏览器覆盖画面。</div>
  <div class="np-switch-box">
    <div class="np-switch-head">
      <span class="np-switch-title">券面强制显示</span>
      <label class="np-switch" title="刷新后仍显示">
        <input type="checkbox" id="npOverlayOn" />
        <span class="np-switch-slider"></span>
      </label>
    </div>
    <p class="np-switch-hint">开启后替换/插入券面姓名。iPhone 使用済み券有时官方不显示姓名，开此开关并填写姓名即可补上；刷新后仍有效。</p>
    <div class="np-row" style="margin-bottom:0">
      <label>券面显示姓名</label>
      <input id="npOverlayName" placeholder="李 楷彤 或 WU JIAN" />
    </div>
    <button class="np-btn np-btn-secondary np-btn-full" id="npSyncOverlay" type="button" style="margin-top:8px;height:38px">用下方姓名填入</button>
    <div class="np-switch-head" style="margin-top:10px;margin-bottom:0">
      <span class="np-switch-title" style="font-size:13px">隐藏插件按钮</span>
      <label class="np-switch" title="隐藏右下角改名与左下角绿条">
        <input type="checkbox" id="npHideUi" />
        <span class="np-switch-slider"></span>
      </label>
    </div>
    <p class="np-switch-hint" style="margin-top:6px;margin-bottom:0">隐藏后连点屏幕右下角两次可再打开设置</p>
  </div>
  <div class="np-row">
    <label>快速录入（从 Excel 复制整行粘贴于此）</label>
    <textarea id="npPaste" rows="2" placeholder="例：张三 男 1995-05-20 Password123（自动拆分各项）"></textarea>
  </div>
  <div class="np-grid">
    <div class="np-row"><label>姓 L_NAME</label><input id="npL" /></div>
    <div class="np-row"><label>名 F_NAME</label><input id="npF" /></div>
    <div class="np-row"><label>片假名姓（可选）</label><input id="npLk" placeholder="リ" /></div>
    <div class="np-row"><label>片假名名（可选）</label><input id="npFk" placeholder="カイトウ" /></div>
  </div>
  <div class="np-grid">
    <div class="np-row">
      <label>生日 BIRTH（YYYY-MM-DD）</label>
      <input id="npBirthday" type="date" placeholder="1999-07-12" />
    </div>
    <div class="np-row">
      <label>性别 SEX</label>
      <select id="npGender">
        <option value="M">男 (M)</option>
        <option value="F">女 (F)</option>
      </select>
    </div>
  </div>
  <div class="np-row">
    <label>账号密码（提交 confirm 必填，不会保存）</label>
    <input id="npPwd" type="password" placeholder="Lp149717" autocomplete="current-password" />
  </div>
  <div class="np-btns">
    <button class="np-btn np-btn-secondary" id="npLoad" type="button">读取当前</button>
    <button class="np-btn np-btn-secondary" id="npQuickFill" type="button">快速填充</button>
    <button class="np-btn np-btn-primary np-btn-full" id="npSubmit" type="button">提交修改</button>
    <button class="np-btn np-btn-secondary np-btn-full" id="npVerify" type="button">验证券面 / 订单</button>
  </div>
  <div class="np-log" id="npLog">请先登录 NAMCO，再点「读取当前」。</div>
</div>
<div id="npOverlayBadge"></div>`;
  document.documentElement.appendChild(root);

  const fab = $('#npRenameFab', root);
  const mask = $('#npRenameMask', root);
  const panel = $('#npRenamePanel', root);
  const logEl = $('#npLog', root);
  const overlayBadge = $('#npOverlayBadge', root);

  function log(msg) {
    logEl.textContent = msg;
  }

  function refreshOverlayBadge() {
    if (shouldHidePluginUi()) {
      overlayBadge.style.display = 'none';
      return;
    }
    const cfg = getOverlayConfig();
    if (cfg.enabled && cfg.displayName) {
      overlayBadge.style.display = 'block';
      overlayBadge.textContent = '券面强制显示：' + cfg.displayName;
    } else {
      overlayBadge.style.display = 'none';
    }
  }

  function refreshPluginUiVisibility() {
    fab.style.display = shouldHidePluginUi() ? 'none' : '';
    refreshOverlayBadge();
  }

  function loadHideUiToUI() {
    $('#npHideUi', root).checked = shouldHidePluginUi();
  }

  function syncOverlayFromForm() {
    const name = buildDisplayName(
      $('#npL', root).value.trim(),
      $('#npF', root).value.trim()
    );
    if (name) $('#npOverlayName', root).value = name;
    return name;
  }

  function saveOverlayFromUI() {
    const enabled = $('#npOverlayOn', root).checked;
    const displayName = ($('#npOverlayName', root).value || syncOverlayFromForm()).trim();
    setOverlayConfig({ enabled, displayName });
    refreshPluginUiVisibility();
    if (enabled && displayName) {
      findTicketNameNodes(document, true).forEach((el) => {
        el.dataset.npOverlay = '1';
      });
      const n = applyTicketOverlay(true);
      return { enabled, displayName, patched: n };
    }
    return { enabled, displayName, patched: 0 };
  }

  function loadOverlayToUI() {
    const cfg = getOverlayConfig();
    $('#npOverlayOn', root).checked = !!cfg.enabled;
    if (cfg.displayName) $('#npOverlayName', root).value = cfg.displayName;
    loadHideUiToUI();
    refreshPluginUiVisibility();
  }

  function clearAllInputs() {
    $('#npPaste', root).value = '';
    $('#npL', root).value = '';
    $('#npF', root).value = '';
    $('#npLk', root).value = '';
    $('#npFk', root).value = '';
    $('#npBirthday', root).value = '';
    $('#npGender', root).value = 'M';
    $('#npPwd', root).value = '';
    $('#npOverlayName', root).value = '';
  }

  function openPanel() {
    mask.style.display = 'block';
    panel.classList.add('open');
    
    clearAllInputs();

    loadOverlayToUI();
    loadHideUiToUI();
    if (isLoggedInFromDom()) {
      log('✅ 当前页已登录\n• 手机没名字：开「券面强制显示」+ 填姓名\n• 必须在「詳細」页（有 EC 号那页），不是列表页');
    } else {
      log('⚠ 未检测到登录（改服务器资料才需要）\n• 手机券面没名字：直接开「券面强制显示」填姓名即可');
    }
  }

  function closePanel() {
    panel.classList.remove('open');
    mask.style.display = 'none';
    saveOverlayFromUI();
  }

  fab.addEventListener('click', openPanel);
  mask.addEventListener('click', closePanel);
  $('#npRenameClose', root).addEventListener('click', closePanel);

  $('#npHideUi', root).addEventListener('change', () => {
    setHideUi({ hidden: $('#npHideUi', root).checked });
    refreshPluginUiVisibility();
  });

  (function setupSecretOpen() {
    let lastTap = 0;
    function hitCorner(x, y) {
      const margin = 72;
      return x >= window.innerWidth - margin && y >= window.innerHeight - margin;
    }
    function onCornerTap(clientX, clientY) {
      if (!shouldHidePluginUi()) return;
      if (panel.classList.contains('open')) return;
      if (!hitCorner(clientX, clientY)) return;
      const now = Date.now();
      if (now - lastTap < 450) {
        lastTap = 0;
        openPanel();
      } else {
        lastTap = now;
      }
    }
    document.addEventListener(
      'touchend',
      (e) => {
        const t = e.changedTouches && e.changedTouches[0];
        if (t) onCornerTap(t.clientX, t.clientY);
      },
      { passive: true }
    );
    document.addEventListener('click', (e) => {
      if (e.target.closest('#npRenameRoot')) return;
      onCornerTap(e.clientX, e.clientY);
    });
  })();

  $('#npOverlayOn', root).addEventListener('change', () => {
    const r = saveOverlayFromUI();
    if (r.enabled && !r.displayName) {
      log('请先填写「券面显示姓名」');
      $('#npOverlayOn', root).checked = false;
      setOverlayConfig({ enabled: false, displayName: '' });
      refreshPluginUiVisibility();
      return;
    }
    log(r.enabled ? `✅ 券面强制显示已开启：${r.displayName}\n刷新/店员 F5 后会自动再覆盖。` : '券面强制显示已关闭');
  });

  $('#npOverlayName', root).addEventListener('input', () => {
    if ($('#npOverlayOn', root).checked) saveOverlayFromUI();
  });

  $('#npSyncOverlay', root).addEventListener('click', () => {
    const name = syncOverlayFromForm();
    if (!name) {
      log('请先在下方填写完整姓名或姓/名');
      return;
    }
    const r = saveOverlayFromUI();
    log(`券面显示名：${name}${r.enabled ? '（已生效）' : '（请打开开关）'}`);
  });

  loadOverlayToUI();
  refreshPluginUiVisibility();
  if (getOverlayConfig().enabled) applyTicketOverlay(true);

 // 快速填充逻辑：解析从 Excel 复制的整行内容（已补全平假名/片假名支持）
  $('#npQuickFill', root).addEventListener('click', () => {
    const rawText = $('#npPaste', root).value.trim();
    if (!rawText) {
      log('请先粘贴 Excel 行数据到快速录入框');
      return;
    }

    // 1. 优先按 Tab 制表符（Excel 复制的默认分隔符）或 2 个以上空格拆分
    const cols = rawText.split(/\t+|\s{2,}/).map(c => c.trim()).filter(Boolean);
    const tokens = cols.length > 1 ? cols : rawText.split(/\s+/).map(c => c.trim()).filter(Boolean);

    let nameStr = '';
    let kanaStr = '';
    let genderStr = '';
    let bdayStr = '';
    let pwdStr = '';

    // 匹配平假名与片假名的正则表达式（包含长音符号 ー）
    const kanaRegex = /^[\u3040-\u309F\u30A0-\u30FF\u30FC\s]+$/;

    // 2. 智能提取字段
    tokens.forEach(token => {
      // 匹配生日: YYYY-MM-DD / YYYY/MM/DD / 8位数字
      if (!bdayStr && (/^\d{4}[-/\.]\d{1,2}[-/\.]\d{1,2}$/.test(token) || /^\d{8}$/.test(token))) {
        bdayStr = normalizeBirthday(token);
      } 
      // 匹配性别: 男 / 女 / M / F / Male / Female
      else if (!genderStr && /^(男|女|M|F|Male|Female)$/i.test(token)) {
        genderStr = token;
      } 
      // 匹配密码: 包含字母和数字组合且长度 >= 6
      else if (!pwdStr && /^(?=.*[a-zA-Z])(?=.*\d).{6,}$/.test(token)) {
        pwdStr = token;
      } 
      // 匹配平假名/片假名
      else if (!kanaStr && kanaRegex.test(token)) {
        kanaStr = token;
      }
      // 剩余非纯数字文本作为汉字/英文姓名候选
      else if (!nameStr && !/^\d+$/.test(token)) {
        nameStr = token;
      }
    });

    if (!nameStr && tokens.length > 0) nameStr = tokens[0];

    // 3. 拆分汉字/英文 姓与名
    const { l, f } = splitFullName(nameStr);
    $('#npL', root).value = l;
    $('#npF', root).value = f;

    // 4. 拆分假名 姓与名 并填充
    if (kanaStr) {
      const { l: lk, f: fk } = splitFullName(kanaStr);
      $('#npLk', root).value = lk;
      $('#npFk', root).value = fk;
    }

    // 5. 填充性别
    if (genderStr) {
      if (/^(女|F|Female)$/i.test(genderStr)) {
        $('#npGender', root).value = 'F';
      } else if (/^(男|M|Male)$/i.test(genderStr)) {
        $('#npGender', root).value = 'M';
      }
    }

    // 6. 填充生日
    if (bdayStr) {
      $('#npBirthday', root).value = bdayStr;
    }

    // 7. 填充密码
    if (pwdStr) {
      $('#npPwd', root).value = pwdStr;
    }

    // 8. 同步填充券面显示姓名
    const fullName = `${l} ${f}`.trim();
    if (fullName) {
      $('#npOverlayName', root).value = fullName;
    }

    const lkVal = $('#npLk', root).value;
    const fkVal = $('#npFk', root).value;
    log(`✅ 快速填充完成：\n• 姓名：${l} ${f}\n• 假名：${lkVal || fkVal ? `${lkVal} ${fkVal}` : '未匹配'}\n• 性别：${$('#npGender', root).value === 'F' ? '女 (F)' : '男 (M)'}\n• 生日：${bdayStr || '未匹配'}\n• 密码：${pwdStr ? '已自动填充' : '未匹配'}`);
  });

  $('#npLoad', root).addEventListener('click', async () => {
    log('读取中…');
    try {
      const ok = await checkLoggedIn();
      if (!ok) throw new Error('未登录，请打开网站先登录');
      const p = await loadProfile();
      const sexLabel = p.gender === 'F' ? '女 (F)' : '男 (M)';
      log(
        `当前会员\n氏名：${p.last_name} ${p.first_name}\nカナ：${p.last_name_kana} ${p.first_name_kana}\n生日：${p.birthday}\n性别：${sexLabel}\n手机：${p.tel}\n邮箱：${p.email}`
      );
      $('#npL', root).value = p.last_name || '';
      $('#npF', root).value = p.first_name || '';
      if (!$('#npLk', root).value) $('#npLk', root).value = p.last_name_kana || '';
      if (!$('#npFk', root).value) $('#npFk', root).value = p.first_name_kana || '';
      $('#npBirthday', root).value = normalizeBirthday(p.birthday);
      $('#npGender', root).value = p.gender || 'M';
    } catch (e) {
      log('❌ ' + e.message);
    }
  });

  $('#npSubmit', root).addEventListener('click', async () => {
    const l = $('#npL', root).value.trim();
    const f = $('#npF', root).value.trim();
    const bdayRaw = $('#npBirthday', root).value.trim();
    const pwd = $('#npPwd', root).value;
    const gender = $('#npGender', root).value;
    if (!l || !f) {
      log('请填写姓和名');
      return;
    }
    if (bdayRaw && !normalizeBirthday(bdayRaw)) {
      log('生日格式无效，请用 YYYY-MM-DD');
      return;
    }
    if (!pwd) {
      log('请填写账号密码');
      return;
    }
    log('提交中…请勿关页面');
    try {
      const profile = await loadProfile();
      const changes = {
        last_name: l,
        first_name: f,
        nickname: l,
        gender,
      };
      const lk = $('#npLk', root).value.trim();
      const fk = $('#npFk', root).value.trim();
      if (lk) changes.last_name_kana = lk;
      if (fk) changes.first_name_kana = fk;
      const bday = normalizeBirthday(bdayRaw);
      if (bday) changes.birthday = bday;
      await updateMemberName(profile, changes, pwd);
      const after = await loadProfile();
      const sexLabel = after.gender === 'F' ? '女 (F)' : '男 (M)';
      log(
        `✅ 会员资料已更新\n` +
          `新氏名：${after.last_name} ${after.first_name}\n` +
          `カナ：${after.last_name_kana} ${after.first_name_kana}\n` +
          `生日：${after.birthday}\n` +
          `性别：${sexLabel}\n` +
          `建议开启「券面强制显示」并验证券面。`
      );
    } catch (e) {
      log('❌ ' + e.message);
    }
  });

  $('#npVerify', root).addEventListener('click', async () => {
    log('验证中…');
    try {
      const v = await verifyTicketNames();
      const prof = await loadProfile();
      const sexLabel = prof.gender === 'F' ? '女 (F)' : '男 (M)';
      let msg = `会员资料：${v.member}\n片假名：${v.kana || '(空)'}\n生日：${prof.birthday || '(空)'}\n性别：${sexLabel}\n`;
      if (v.clients.length) msg += `订单ご依頼主：${v.clients[0]}\n`;
      if (!v.tickets.length) {
        msg += '当前无入場チケット。';
      } else {
        v.tickets.forEach((t) => {
          const ok = t.name === v.member;
          msg += `\n券面 [${t.ec}]：${t.name}  ${ok ? '✅与会员一致' : '❌仍为订单快照'}`;
        });
      }
      log(msg);
    } catch (e) {
      log('❌ ' + e.message);
    }
  });
})();