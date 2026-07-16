/**
 * tv-grid.js — quick-shop grid for the <tv-product-grid> custom element.
 *
 * Responsibilities:
 *   - Open a single popup (one dialog per section instance) from any hotspot.
 *   - Render product info + variant options DYNAMICALLY from a JSON payload that
 *     was built server-side in Liquid (id/title/description/image/options/variants,
 *     every price already formatted with `| money`). The client NEVER formats
 *     currency and NEVER fetches product data to open a popup.
 *   - The "Color" option renders as a pill/button group (selected value marked by
 *     a 5px black left bar) and is shown first; every other option is a <select>.
 *     Matching is by option NAME, so it works whatever order the product lists
 *     its options in. With no colour option it falls back to option index 0.
 *   - Resolve the selected variant, drive ADD TO CART state (disabled / UNAVAILABLE
 *     / SOLD OUT), and add to cart via {{ routes.cart_add_url }}.
 *   - Auto-add rule: if the chosen variant's options include BOTH "Black" and
 *     "Medium" (case-insensitive, any order), also add a companion product.
 *
 * Architecture: one delegated click listener + one delegated change listener on
 * the element root, a document-level Escape handler cleaned up on disconnect,
 * payloads memoised in a Map, body scroll locked while the popup is open.
 * Vanilla JS only — no libraries.
 */

/**
 * @typedef {Object} TvVariant
 * @property {number} id
 * @property {string[]} options
 * @property {boolean} available
 * @property {string} price
 */

/**
 * @typedef {Object} TvProduct
 * @property {number} id
 * @property {string} title
 * @property {string} description
 * @property {string} image
 * @property {boolean} hasOnlyDefaultVariant
 * @property {string[]} options
 * @property {string} price
 * @property {TvVariant[]} variants
 */

/**
 * @typedef {Object} TvState
 * @property {TvProduct} product
 * @property {(string|null)[]} selected
 * @property {boolean} hasOptions
 * @property {TvVariant|null} variant
 */

(() => {
  const LABEL_DEFAULT = 'ADD TO CART';
  const LABEL_ADDED = 'ADDED ✓';
  const LABEL_UNAVAILABLE = 'UNAVAILABLE';
  const LABEL_SOLDOUT = 'SOLD OUT';

  class TvProductGrid extends HTMLElement {
    constructor() {
      super();
      /** @type {Map<string, TvProduct|null>} Memoised payloads keyed by block id. */
      this.payloads = new Map();
      /** @type {Promise<number|null>|null} Cached companion-variant lookup. */
      this.companionPromise = null;
      /** @type {TvState|null} Currently open popup state, or null when closed. */
      this.state = null;
      /** @type {HTMLElement|null} Element focus returns to on close. */
      this.previousFocus = null;
      this.cartAddUrl = '';
      this.rootUrl = '/';
      this.autoAddHandle = '';

      // Bind delegated handlers once (constructor => never undefined at use sites).
      this.onClick = this.handleClick.bind(this);
      this.onChange = this.handleChange.bind(this);
      this.onKeydown = this.handleKeydown.bind(this);
    }

    connectedCallback() {
      this.cartAddUrl = this.dataset.cartAddUrl || '';
      this.rootUrl = this.dataset.rootUrl || '/';
      this.autoAddHandle = (this.dataset.autoAddHandle || '').trim();

      // Delegated listeners — one of each on the root.
      this.addEventListener('click', this.onClick);
      this.addEventListener('change', this.onChange);
      document.addEventListener('keydown', this.onKeydown);
    }

    disconnectedCallback() {
      // Remove the only listener that lives outside this element.
      document.removeEventListener('keydown', this.onKeydown);
      this.unlockScroll();
    }

    /** @returns {HTMLElement} The single popup dialog wrapper for this section. */
    get popup() {
      return /** @type {HTMLElement} */ (this.querySelector('[data-tv-popup]'));
    }

    /* ---------------------------------------------------------------- events */

    /**
     * Single delegated click handler for the whole section.
     * @param {MouseEvent} event
     */
    handleClick(event) {
      const target = /** @type {HTMLElement} */ (event.target);
      if (!target) return;

      const hotspot = /** @type {HTMLElement|null} */ (target.closest('[data-tv-hotspot]'));
      if (hotspot && this.contains(hotspot)) {
        this.open(hotspot.dataset.tvHotspot || '', hotspot);
        return;
      }

      if (target.closest('[data-tv-close]')) {
        this.close();
        return;
      }

      const optBtn = /** @type {HTMLElement|null} */ (target.closest('[data-tv-opt-btn]'));
      if (optBtn) {
        this.selectOption(Number(optBtn.dataset.optIndex), optBtn.dataset.value || null);
        return;
      }

      if (target.closest('[data-tv-atc]')) {
        this.addToCart();
      }
    }

    /**
     * Delegated change handler for the native <select> option groups.
     * @param {Event} event
     */
    handleChange(event) {
      const target = /** @type {HTMLElement} */ (event.target);
      const select = /** @type {HTMLSelectElement|null} */ (
        target && target.closest('[data-tv-select]')
      );
      if (!select) return;
      this.selectOption(Number(select.dataset.optIndex), select.value || null);
    }

    /**
     * Document-level Escape handler (+ focus trap while open).
     * @param {KeyboardEvent} event
     */
    handleKeydown(event) {
      if (!this.state) return;
      if (event.key === 'Escape') {
        this.close();
      } else if (event.key === 'Tab') {
        this.trapFocus(event);
      }
    }

    /* ----------------------------------------------------------- popup open */

    /**
     * Read (and memoise) a block's JSON payload.
     * @param {string} blockId
     * @returns {TvProduct|null}
     */
    getPayload(blockId) {
      if (this.payloads.has(blockId)) return this.payloads.get(blockId) ?? null;
      const node = this.querySelector(`[data-tv-product="${blockId}"]`);
      /** @type {TvProduct|null} */
      let data = null;
      if (node) {
        try {
          data = JSON.parse(node.textContent || 'null');
        } catch (err) {
          data = null;
        }
      }
      this.payloads.set(blockId, data);
      return data;
    }

    /**
     * Index of the option that renders as pills — the "Color" option
     * (case-insensitive), falling back to option 0 when there is none.
     * @param {TvProduct} product
     * @returns {number}
     */
    pillIndex(product) {
      const idx = product.options.findIndex((name) => {
        const lower = String(name).toLowerCase();
        return lower === 'color' || lower === 'colour';
      });
      return idx === -1 ? 0 : idx;
    }

    /**
     * Open and fill the popup for a block.
     * @param {string} blockId
     * @param {HTMLElement} trigger element that opened the popup (for focus return)
     */
    open(blockId, trigger) {
      const product = this.getPayload(blockId);
      if (!product) return;

      // selected[i] holds the chosen value for option index i (null = unchosen).
      // Preselect the pill (Color) option per Figma; leave the rest to the shopper.
      const hasOptions = !product.hasOnlyDefaultVariant && product.options.length > 0;
      /** @type {(string|null)[]} */
      const selected = hasOptions ? product.options.map(() => null) : [];
      if (hasOptions) {
        const pill = this.pillIndex(product);
        selected[pill] = this.optionValues(product, pill)[0] || null;
      }

      this.state = { product, selected, hasOptions, variant: null };

      this.fill(product);
      this.renderOptions(product, selected);
      this.update();

      this.popup.hidden = false;
      this.lockScroll();

      // Move focus into the dialog and remember where it came from.
      this.previousFocus = trigger || /** @type {HTMLElement|null} */ (document.activeElement);
      const close = /** @type {HTMLElement|null} */ (this.popup.querySelector('[data-tv-close]'));
      if (close) close.focus();
    }

    /**
     * Write the static product fields into the dialog shell.
     * @param {TvProduct} product
     */
    fill(product) {
      const img = /** @type {HTMLImageElement|null} */ (this.popup.querySelector('[data-tv-img]'));
      if (img) {
        img.src = product.image || '';
        img.alt = product.title || '';
      }
      this.setText('[data-tv-title]', product.title);
      this.setText('[data-tv-price]', product.price);
      this.setText('[data-tv-desc]', product.description);
      this.setError('');
    }

    /* -------------------------------------------------------- option render */

    /**
     * Unique values for a given option index, in first-seen order.
     * @param {TvProduct} product
     * @param {number} index
     * @returns {string[]}
     */
    optionValues(product, index) {
      /** @type {string[]} */
      const seen = [];
      product.variants.forEach((v) => {
        const value = v.options[index];
        if (value != null && !seen.includes(value)) seen.push(value);
      });
      return seen;
    }

    /**
     * Build the option groups: the pill (Color) option first, all others as
     * <select>. Hidden entirely for default-variant-only products.
     * @param {TvProduct} product
     * @param {(string|null)[]} selected
     */
    renderOptions(product, selected) {
      const host = /** @type {HTMLElement|null} */ (this.popup.querySelector('[data-tv-options]'));
      if (!host) return;
      host.innerHTML = '';
      if (product.hasOnlyDefaultVariant || product.options.length === 0) return;

      const pill = this.pillIndex(product);
      // Pill group first, remaining options after in their original order.
      /** @type {number[]} */
      const order = [pill];
      product.options.forEach((_name, i) => {
        if (i !== pill) order.push(i);
      });

      order.forEach((index) => {
        const name = product.options[index] || '';
        const group = document.createElement('div');
        group.className = 'tv-opt';

        const label = document.createElement('span');
        label.className = 'tv-opt__name';
        label.textContent = name;
        group.appendChild(label);

        if (index === pill) {
          group.appendChild(this.buildButtons(product, index, selected[index] ?? null, name));
        } else {
          group.appendChild(this.buildSelect(product, index, name));
        }
        host.appendChild(group);
      });
    }

    /**
     * Pill/button group for the Color option.
     * @param {TvProduct} product
     * @param {number} index
     * @param {string|null} selectedValue
     * @param {string} name
     * @returns {HTMLElement}
     */
    buildButtons(product, index, selectedValue, name) {
      const wrap = document.createElement('div');
      wrap.className = 'tv-opt__btns';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', name);

      this.optionValues(product, index).forEach((value) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tv-opt__btn';
        btn.dataset.tvOptBtn = '';
        btn.dataset.optIndex = String(index);
        btn.dataset.value = value;
        btn.textContent = value;
        // Colour the selected pill's left bar to match the actual colour.
        btn.style.setProperty('--tv-swatch', this.colorSwatch(value));
        const isSelected = value === selectedValue;
        btn.classList.toggle('is-selected', isSelected);
        btn.setAttribute('aria-pressed', String(isSelected));
        wrap.appendChild(btn);
      });
      return wrap;
    }

    /**
     * Best-effort CSS colour for an option value, used for the selected pill's
     * left swatch bar. Uses CSS.supports so any valid colour name works; falls
     * back to black when the value is not a recognisable colour.
     * @param {string} value
     * @returns {string}
     */
    colorSwatch(value) {
      const raw = String(value).trim().toLowerCase();
      /** @type {Record<string, string>} */
      const aliases = {
        'navy blue': '#001f5b',
        'off white': '#f2efe6',
        'light grey': '#d3d3d3',
        'light gray': '#d3d3d3',
        'dark grey': '#555555',
        'dark gray': '#555555',
      };
      if (aliases[raw]) return aliases[raw];
      const canUse = typeof CSS !== 'undefined' && typeof CSS.supports === 'function';
      const compact = raw.replace(/\s+/g, '');
      if (canUse && CSS.supports('color', compact)) return compact;
      if (canUse && CSS.supports('color', raw)) return raw;
      return '#000';
    }

    /**
     * Native <select> for a non-colour option, with a disabled placeholder.
     * @param {TvProduct} product
     * @param {number} index
     * @param {string} name
     * @returns {HTMLElement}
     */
    buildSelect(product, index, name) {
      const wrap = document.createElement('div');
      wrap.className = 'tv-opt__select-wrap';

      const select = document.createElement('select');
      select.className = 'tv-opt__select';
      select.dataset.tvSelect = '';
      select.dataset.optIndex = String(index);
      select.setAttribute('aria-label', name);

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = `Choose your ${name.toLowerCase()}`;
      select.appendChild(placeholder);

      this.optionValues(product, index).forEach((value) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
      });

      const chevron = document.createElement('span');
      chevron.className = 'tv-opt__chevron';
      chevron.setAttribute('aria-hidden', 'true');

      wrap.appendChild(select);
      wrap.appendChild(chevron);
      return wrap;
    }

    /* --------------------------------------------------------- state update */

    /**
     * Record a selection for an option index and refresh derived state.
     * @param {number} index
     * @param {string|null} value
     */
    selectOption(index, value) {
      if (!this.state || !this.state.hasOptions) return;
      this.state.selected[index] = value;

      // Reflect the pill selection visually (no-op for <select> option groups).
      this.popup
        .querySelectorAll(`[data-tv-opt-btn][data-opt-index="${index}"]`)
        .forEach((node) => {
          const btn = /** @type {HTMLElement} */ (node);
          const on = btn.dataset.value === value;
          btn.classList.toggle('is-selected', on);
          btn.setAttribute('aria-pressed', String(on));
        });
      this.update();
    }

    /**
     * Resolve the variant matching every selected option (null if incomplete
     * or if the combination does not exist).
     * @returns {TvVariant|null}
     */
    resolveVariant() {
      if (!this.state) return null;
      const { product, selected, hasOptions } = this.state;
      if (!hasOptions) return product.variants[0] || null;
      if (selected.some((v) => v == null)) return null;
      return (
        product.variants.find((v) => selected.every((value, i) => v.options[i] === value)) || null
      );
    }

    /** Recompute price + ADD TO CART button state from the current selection. */
    update() {
      if (!this.state) return;
      const { product, selected, hasOptions } = this.state;
      const complete = !hasOptions || selected.every((v) => v != null);
      const variant = complete ? this.resolveVariant() : null;
      this.state.variant = variant;

      // Price follows the resolved variant, else falls back to the default.
      this.setText('[data-tv-price]', variant ? variant.price : product.price);

      const atc = /** @type {HTMLButtonElement|null} */ (this.popup.querySelector('[data-tv-atc]'));
      const labelEl = this.popup.querySelector('[data-tv-atc-label]');
      let label = LABEL_DEFAULT;
      let disabled = true;

      if (!complete) {
        disabled = true;
      } else if (!variant) {
        label = LABEL_UNAVAILABLE;
      } else if (!variant.available) {
        label = LABEL_SOLDOUT;
      } else {
        disabled = false;
      }

      if (atc) atc.disabled = disabled;
      if (labelEl) labelEl.textContent = label;
    }

    /* ------------------------------------------------------------- add cart */

    /** Add the resolved variant (plus companion when the rule fires) to the cart. */
    async addToCart() {
      if (!this.state || !this.state.variant) return;
      const variant = this.state.variant;
      const atc = /** @type {HTMLButtonElement|null} */ (this.popup.querySelector('[data-tv-atc]'));
      const labelEl = this.popup.querySelector('[data-tv-atc-label]');

      const items = [{ id: variant.id, quantity: 1 }];

      // Auto-add rule: companion goes into the SAME request (no race).
      if (this.matchesBlackAndMedium(variant.options)) {
        const companionId = await this.getCompanionVariant();
        if (companionId) items.push({ id: companionId, quantity: 1 });
      }

      if (atc) atc.disabled = true;
      this.setError('');

      try {
        const res = await fetch(this.cartAddUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items, sections: 'cart-icon-bubble' }),
        });
        const data = await res.json();

        if (!res.ok) {
          // Surface Shopify's 422 message inline.
          this.setError(data.description || 'Sorry, this item could not be added.');
          if (atc) atc.disabled = false;
          return;
        }

        this.updateCartBubble(data.sections);
        if (labelEl) labelEl.textContent = LABEL_ADDED;
        window.setTimeout(() => this.close(), 900);
      } catch (err) {
        this.setError('Something went wrong. Please try again.');
        if (atc) atc.disabled = false;
      }
    }

    /**
     * True when the option values include BOTH "black" and "medium"
     * (case-insensitive, any order).
     * @param {string[]} options
     * @returns {boolean}
     */
    matchesBlackAndMedium(options) {
      const lower = options.map((o) => String(o).toLowerCase());
      return lower.includes('black') && lower.includes('medium');
    }

    /**
     * Lazily fetch the companion product once and cache the promise; resolves to
     * its first available variant id, or null (fail soft).
     * @returns {Promise<number|null>}
     */
    getCompanionVariant() {
      if (!this.autoAddHandle) return Promise.resolve(null);
      if (!this.companionPromise) {
        const base = this.rootUrl.replace(/\/$/, '');
        const url = `${base}/products/${this.autoAddHandle}.js`;
        this.companionPromise = fetch(url)
          .then((res) => (res.ok ? res.json() : null))
          .then((product) => {
            if (!product || !product.variants) return null;
            const available = product.variants.find((/** @type {any} */ v) => v.available);
            return available ? available.id : null;
          })
          .catch(() => null);
      }
      return this.companionPromise;
    }

    /**
     * Swap Dawn's #cart-icon-bubble from the returned section HTML (guard if absent).
     * @param {Record<string, string>|undefined} sections
     */
    updateCartBubble(sections) {
      if (!sections) return;
      const html = sections['cart-icon-bubble'];
      const bubble = document.getElementById('cart-icon-bubble');
      if (!html || !bubble) return;
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const fresh = parsed.getElementById('cart-icon-bubble');
      if (fresh) bubble.innerHTML = fresh.innerHTML;
    }

    /* ---------------------------------------------------------- close/utils */

    close() {
      if (!this.state) return;
      this.popup.hidden = true;
      this.unlockScroll();
      const returnTo = this.previousFocus;
      this.state = null;
      // Restore focus to the hotspot that opened the popup.
      if (returnTo && typeof returnTo.focus === 'function') returnTo.focus();
    }

    /**
     * Keep Tab focus inside the dialog while it is open.
     * @param {KeyboardEvent} event
     */
    trapFocus(event) {
      const nodes = this.popup.querySelectorAll(
        'button, select, a[href], [tabindex]:not([tabindex="-1"])'
      );
      const list = /** @type {HTMLElement[]} */ (Array.from(nodes)).filter(
        (el) => !el.matches('[disabled]') && el.offsetParent !== null
      );
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    lockScroll() {
      document.body.style.overflow = 'hidden';
    }

    unlockScroll() {
      document.body.style.overflow = '';
    }

    /**
     * @param {string} selector
     * @param {string} value
     */
    setText(selector, value) {
      const el = this.popup.querySelector(selector);
      if (el) el.textContent = value == null ? '' : value;
    }

    /** @param {string} message empty string hides the alert. */
    setError(message) {
      const el = /** @type {HTMLElement|null} */ (this.popup.querySelector('[data-tv-error]'));
      if (!el) return;
      el.textContent = message;
      el.hidden = !message;
    }
  }

  if (!customElements.get('tv-product-grid')) {
    customElements.define('tv-product-grid', TvProductGrid);
  }
})();
