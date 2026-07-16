/**
 * tv-grid.js — quick-shop grid for the <tv-product-grid> custom element.
 *
 * Responsibilities:
 *   - Open a single popup (one dialog per section instance) from any hotspot.
 *   - Render product info + variant options DYNAMICALLY from a JSON payload that
 *     was built server-side in Liquid (id/title/description/image/options/variants,
 *     every price already formatted with `| money`). The client NEVER formats
 *     currency and NEVER fetches product data to open a popup.
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

(() => {
  const LABEL_DEFAULT = 'ADD TO CART';
  const LABEL_ADDED = 'ADDED ✓';
  const LABEL_UNAVAILABLE = 'UNAVAILABLE';
  const LABEL_SOLDOUT = 'SOLD OUT';

  class TvProductGrid extends HTMLElement {
    connectedCallback() {
      /** @type {Map<string, object>} Memoised payloads keyed by block id. */
      this.payloads = new Map();
      /** @type {Promise<number|null>|null} Cached companion-variant lookup. */
      this.companionPromise = null;
      /** Currently open popup state, or null when closed. */
      this.state = null;

      this.cartAddUrl = this.dataset.cartAddUrl;
      this.rootUrl = this.dataset.rootUrl || '/';
      this.autoAddHandle = (this.dataset.autoAddHandle || '').trim();

      this.popup = this.querySelector('[data-tv-popup]');

      // Delegated listeners — one of each on the root.
      this.onClick = this.handleClick.bind(this);
      this.onChange = this.handleChange.bind(this);
      this.onKeydown = this.handleKeydown.bind(this);
      this.addEventListener('click', this.onClick);
      this.addEventListener('change', this.onChange);
      document.addEventListener('keydown', this.onKeydown);
    }

    disconnectedCallback() {
      // Remove the only listener that lives outside this element.
      document.removeEventListener('keydown', this.onKeydown);
      this.unlockScroll();
    }

    /* ---------------------------------------------------------------- events */

    /**
     * Single delegated click handler for the whole section.
     * @param {MouseEvent} event
     */
    handleClick(event) {
      const hotspot = event.target.closest('[data-tv-hotspot]');
      if (hotspot && this.contains(hotspot)) {
        this.open(hotspot.dataset.tvHotspot, hotspot);
        return;
      }

      if (event.target.closest('[data-tv-close]')) {
        this.close();
        return;
      }

      const optBtn = event.target.closest('[data-tv-opt-btn]');
      if (optBtn) {
        this.selectOption(0, optBtn.dataset.value);
        return;
      }

      if (event.target.closest('[data-tv-atc]')) {
        this.addToCart();
      }
    }

    /**
     * Delegated change handler for the native <select> option groups.
     * @param {Event} event
     */
    handleChange(event) {
      const select = event.target.closest('[data-tv-select]');
      if (!select) return;
      this.selectOption(Number(select.dataset.optIndex), select.value || null);
    }

    /**
     * Document-level Escape handler.
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
     * @returns {object|null}
     */
    getPayload(blockId) {
      if (this.payloads.has(blockId)) return this.payloads.get(blockId);
      const node = this.querySelector(`[data-tv-product="${blockId}"]`);
      if (!node) return null;
      let data = null;
      try {
        data = JSON.parse(node.textContent);
      } catch (err) {
        data = null;
      }
      this.payloads.set(blockId, data);
      return data;
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
      // Preselect option 0 (per Figma) but leave the rest for the shopper.
      const hasOptions = !product.hasOnlyDefaultVariant && product.options.length > 0;
      const selected = hasOptions ? product.options.map(() => null) : [];
      if (hasOptions) selected[0] = this.optionValues(product, 0)[0] || null;

      this.state = { product, selected, hasOptions, variant: null, trigger };

      this.fill(product);
      this.renderOptions(product, selected);
      this.update();

      this.popup.hidden = false;
      this.lockScroll();

      // Move focus into the dialog and remember where it came from.
      this.previousFocus = trigger || document.activeElement;
      const close = this.popup.querySelector('[data-tv-close]');
      if (close) close.focus();
    }

    /**
     * Write the static product fields into the dialog shell.
     * @param {object} product
     */
    fill(product) {
      const img = this.popup.querySelector('[data-tv-img]');
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
     * @param {object} product
     * @param {number} index
     * @returns {string[]}
     */
    optionValues(product, index) {
      const seen = [];
      product.variants.forEach((v) => {
        const value = v.options[index];
        if (value != null && !seen.includes(value)) seen.push(value);
      });
      return seen;
    }

    /**
     * Build the option groups: index 0 -> button group, index 1+ -> <select>.
     * Hidden entirely for default-variant-only products.
     * @param {object} product
     * @param {(string|null)[]} selected
     */
    renderOptions(product, selected) {
      const host = this.popup.querySelector('[data-tv-options]');
      if (!host) return;
      host.innerHTML = '';
      if (product.hasOnlyDefaultVariant || product.options.length === 0) return;

      product.options.forEach((name, index) => {
        const group = document.createElement('div');
        group.className = 'tv-opt';

        const label = document.createElement('span');
        label.className = 'tv-opt__name';
        label.textContent = name;
        group.appendChild(label);

        if (index === 0) {
          group.appendChild(this.buildButtons(product, index, selected[index], name));
        } else {
          group.appendChild(this.buildSelect(product, index, name));
        }
        host.appendChild(group);
      });
    }

    /**
     * Button group for option index 0.
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
        btn.dataset.value = value;
        btn.textContent = value;
        const isSelected = value === selectedValue;
        btn.classList.toggle('is-selected', isSelected);
        btn.setAttribute('aria-pressed', String(isSelected));
        wrap.appendChild(btn);
      });
      return wrap;
    }

    /**
     * Native <select> for option index 1+, with a disabled placeholder.
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

      if (index === 0) {
        // Reflect the selected button visually.
        this.popup.querySelectorAll('[data-tv-opt-btn]').forEach((btn) => {
          const on = btn.dataset.value === value;
          btn.classList.toggle('is-selected', on);
          btn.setAttribute('aria-pressed', String(on));
        });
      }
      this.update();
    }

    /**
     * Resolve the variant matching every selected option (null if incomplete
     * or if the combination does not exist).
     * @returns {object|null}
     */
    resolveVariant() {
      const { product, selected, hasOptions } = this.state;
      if (!hasOptions) return product.variants[0] || null;
      if (selected.some((v) => v == null)) return null;
      return (
        product.variants.find((v) =>
          selected.every((value, i) => v.options[i] === value)
        ) || null
      );
    }

    /**
     * Recompute price + ADD TO CART button state from the current selection.
     */
    update() {
      const { product, selected, hasOptions } = this.state;
      const complete = !hasOptions || selected.every((v) => v != null);
      const variant = complete ? this.resolveVariant() : null;
      this.state.variant = variant;

      // Price follows the resolved variant, else falls back to the default.
      this.setText('[data-tv-price]', variant ? variant.price : product.price);

      const atc = this.popup.querySelector('[data-tv-atc]');
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

    /**
     * Add the resolved variant (plus companion when the rule fires) to the cart.
     */
    async addToCart() {
      if (!this.state || !this.state.variant) return;
      const variant = this.state.variant;
      const atc = this.popup.querySelector('[data-tv-atc]');
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
            const available = product.variants.find((v) => v.available);
            return available ? available.id : null;
          })
          .catch(() => null);
      }
      return this.companionPromise;
    }

    /**
     * Swap Dawn's #cart-icon-bubble from the returned section HTML (guard if absent).
     * @param {object|undefined} sections
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
      const focusables = this.popup.querySelectorAll(
        'button, select, a[href], [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.from(focusables).filter((el) => !el.disabled && el.offsetParent !== null);
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
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
      const el = this.popup.querySelector('[data-tv-error]');
      if (!el) return;
      el.textContent = message;
      el.hidden = !message;
    }
  }

  if (!customElements.get('tv-product-grid')) {
    customElements.define('tv-product-grid', TvProductGrid);
  }
})();
