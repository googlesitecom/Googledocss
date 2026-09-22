/* emoji.js — selector de emojis para el compositor (estilo WhatsApp)
   Un panel con categorías que inserta el emoji en la posición del
   cursor del textarea. Sin dependencias: lista curada incluida.    */
'use strict';

const Emoji = {
  CATS: [
    { id: 'caras', icon: '😀', list: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 💀 ☠️ 🤡 👹 👺 👻 👽 🤖 💩 😺 😸 😹 😻 😼 😽 🙀 😿 😾' },
    { id: 'gestos', icon: '👍', list: '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 💋 🩸' },
    { id: 'corazones', icon: '❤️', list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 🔥 ✨ 🌟 💫 ⭐️ 🎉 🎊 🥳 🎈 🎁 🏆 🥇 🥈 🥉 💯 💢 💥 💫 🌈 ☀️ ⛅️ 🌙 💡' },
    { id: 'animales', icon: '🐶', list: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🕷️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦛 🦏 🐪 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🕊️ 🐇 🦝 🦨 🦡 🦦 🦥 🐁 🐀 🦔' },
    { id: 'comida', icon: '🍕', list: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 ☕️ 🍵 🧃 🥤 🧋 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉' },
    { id: 'actividad', icon: '⚽', list: '⚽️ 🏀 🏈 ⚾️ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🥊 🥋 ⛳️ ⛸️ 🎣 🎽 🎿 🛷 🥌 🎯 🪁 🎮 🕹️ 🎲 ♟️ 🧩 🎰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚜 🛵 🏍️ 🚲 🛴 ✈️ 🚀 🛸 🚁 ⛵️ 🚤 🛶 🗺️ 🏝️ 🏔️ 🗽 🗼 🏰 🎡 🎢'}
  ],
  tab: 'caras',

  togglePanel() {
    const p = $('#emojiPanel');
    if (!p) return;
    if (p.hidden) this.openPanel();
    else this.closePanel();
  },

  openPanel() {
    const p = $('#emojiPanel');
    if (!p) return;
    if (typeof Stickers !== 'undefined' && Stickers.closePicker) Stickers.closePicker();
    p.hidden = false;
    this.renderTabs();
    this.renderGrid();
  },

  closePanel() {
    const p = $('#emojiPanel');
    if (p) p.hidden = true;
  },

  renderTabs() {
    const box = $('#emojiTabs');
    if (!box) return;
    box.innerHTML = this.CATS.map((c) => `
      <button class="stk-tab emoji-tab ${this.tab === c.id ? 'active' : ''}" data-cat="${c.id}" title="${esc(c.id)}">${c.icon}</button>`).join('');
  },

  renderGrid() {
    const grid = $('#emojiGrid');
    if (!grid) return;
    const cat = this.CATS.find((c) => c.id === this.tab) || this.CATS[0];
    grid.innerHTML = cat.list.split(/\s+/).filter(Boolean).map((e) => `
      <button class="emoji-cell" data-emoji="${esc(e)}">${e}</button>`).join('');
  },

  setTab(id) {
    this.tab = id;
    this.renderTabs();
    this.renderGrid();
  },

  /* insertar en la posición del cursor del compositor */
  insert(e) {
    const inp = $('#msgInput');
    if (!inp) return;
    const s = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
    const epos = inp.selectionEnd != null ? inp.selectionEnd : s;
    inp.value = inp.value.slice(0, s) + e + inp.value.slice(epos);
    const pos = s + e.length;
    inp.focus();
    try { inp.setSelectionRange(pos, pos); } catch (err) {}
    inp.dispatchEvent(new Event('input'));
    if (typeof Chat !== 'undefined' && Chat.typingThrottle) Chat.typingThrottle();
  }
};
