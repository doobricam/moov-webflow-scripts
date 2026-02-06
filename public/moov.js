/* =========================================================
   MOOV FLOW + CALENDLY (Single external JS file)
   - Safe init even if DOMContentLoaded already fired
   - Keeps your existing data-attributes / Webflow structure
   ========================================================= */

(function () {
  "use strict";

  function initMoov() {
    /* ==============================
       CONFIG
    ============================== */
    const apiAddressBase = "https://unity-platform-backend-2.vercel.app";
    const apiValuation = "https://unity-webflow-proxy.vercel.app/api/valuation";

    // Text label thresholds (per Abdi/Nick)
    const CONFIDENCE_HIGH_MIN = 70;
    const CONFIDENCE_MED_MIN = 40;

    // Nick/Abdi: 3-colour system (sharp boundaries)
    // LOW: 0–39, MEDIUM: 40–69, HIGH: 70–100
    const SCORE_COLORS = {
      LOW: "#BD1B19",
      MEDIUM: "#F7AF2A",
      HIGH: "#238D5B",
    };

    const ANIM_MS = 650;

    /* ==============================
       ELEMENTS
    ============================== */
    const input = document.getElementById("address-search");
    const btn = document.querySelector(".btn-offer-trigger");
    const errorWrap = document.querySelector(".error_wrap");

    const mainWrapper = document.querySelector(".main-wrapper");
    const multistepWrapper = document.querySelector(".multistep-wrapper");
    const popup = document.querySelector(".pop-up_work");

    const resultsContainer = document.querySelector(".results-container");
    const resultsList = document.querySelector(".results-list");
    const skeletonWrap = document.querySelector(".results-skeleton");

    const scrollTrack = document.querySelector(".scrollbar-track");
    const scrollThumb = document.querySelector(".scrollbar-thumb");

    const steps = {
      "step-1": document.getElementById("step-1"),
      "step-2": document.getElementById("step-2"),
      "step-3a": document.getElementById("step-3a"),
      "step-3b": document.getElementById("step-3b"),
      "step-3c": document.getElementById("step-3c"),
      "step-worth": document.getElementById("step-worth"),
      "step-4": document.getElementById("step-4"),
      "step-valuation": document.getElementById("step-valuation"),
    };

    const step4Form = document.getElementById("wf-form-step4");

    const outputAddressEls = document.querySelectorAll("[data-user-address='true']");
    const outputPrice = document.querySelector("[data-valuation-price='true']");
    const outputEstimated = document.querySelector("[data-valuation-estimated='true']");
    const outputRange = document.querySelector("[data-offer-range='true']");
    const outputDate = document.querySelector("[data-valuation-date='true']");
    const outputConfTextEls = document.querySelectorAll('[data-confidence-score="true"]');

    const highWrap =
      document.querySelector('[data-result-high="true"]') ||
      document.querySelector("[data-result-high]") ||
      document.querySelector(".valuation-right.high") ||
      null;

    const lowWrap =
      document.querySelector('[data-result-low="true"]') ||
      document.querySelector("[data-result-low]") ||
      document.querySelector(".valuation-right.low") ||
      null;

    const valLoading = document.querySelector('[data-valuation-loading="true"]');
    const valResults = document.querySelector('[data-valuation-results="true"]');
    const valStatus = document.querySelector('[data-valuation-status="true"]');

    /* ==============================
       STATE
    ============================== */
    let selectedAddress = null;
    let resolvedAddress = null;

    let valuationAbortController = null;
    let resolveAbortController = null;

    let valuationStarted = false;

    // Anti-race guards
    let flowRunId = 0;

    // Track whether we already have valuation results for current run
    let valuationCompleteForRun = false;

    // Confidence animation should run only when step-valuation is shown
    let pendingConfidence = null; // { score, label }
    let hasAnimatedConfidenceForRun = false;

    /* ==============================
       HELPERS
    ============================== */
    const postJSON = async (url, payload, opts = {}) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...opts,
      });
      if (!r.ok) throw new Error(`${url} failed: ${r.status}`);
      return r.json();
    };

    function formatUKPostcode(pc) {
      if (!pc) return "";
      const clean = pc.toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9]/g, "");
      if (clean.length <= 3) return clean;
      return (clean.slice(0, -3) + " " + clean.slice(-3)).trim();
    }

    function normalizePostcode(pc) {
      return (pc || "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9]/g, "").trim();
    }

    function extractHouseNumber(line1) {
      const s = (line1 || "").trim();
      if (!s) return "";
      const flatMatch = s.match(/^(Flat|Apartment|Apt|Unit|Studio)\s+[^,]+/i);
      if (flatMatch) return flatMatch[0].trim();
      const numMatch = s.match(/^\d+[A-Za-z]?\b/);
      if (numMatch) return numMatch[0];
      return s;
    }

    function inferPropertyTypeFromAddressLine(line1) {
      const s = (line1 || "").trim().toLowerCase();
      if (!s) return "";
      if (
        s.startsWith("flat") ||
        s.startsWith("apartment") ||
        s.startsWith("apt") ||
        s.startsWith("unit") ||
        s.startsWith("studio")
      )
        return "flat";
      return "house";
    }

    function money(n) {
      const x = Number(n);
      if (!isFinite(x) || x <= 0) return "";
      return "£" + Math.round(x).toLocaleString("en-GB");
    }

    function setOfferBtnEnabled(enabled) {
      if (!btn) return;
      btn.classList.toggle("is-disabled", !enabled);
      btn.setAttribute("aria-disabled", enabled ? "false" : "true");
      if (btn.tagName.toLowerCase() === "button") btn.disabled = !enabled;
    }

    function showError(msg) {
      if (!errorWrap) return;
      const msgEl = errorWrap.querySelector("[data-error-text]") || errorWrap.querySelector(".error_text");
      if (msgEl && msg) msgEl.textContent = msg;
      errorWrap.style.display = "block";
      errorWrap.style.opacity = "1";
      errorWrap.style.pointerEvents = "auto";
    }

    function hideError() {
      if (!errorWrap) return;
      errorWrap.style.opacity = "0";
      errorWrap.style.pointerEvents = "none";
      setTimeout(() => {
        if (errorWrap.style.opacity === "0") errorWrap.style.display = "none";
      }, 150);
    }

    function openResults() {
      resultsContainer?.classList.add("is-open");
    }
    function closeResults() {
      resultsContainer?.classList.remove("is-open");
    }
    function clearResults() {
      if (resultsList) resultsList.innerHTML = "";
    }
    function clearSelection() {
      selectedAddress = null;
      setOfferBtnEnabled(false);
    }

    function showSkeleton() {
      if (!resultsContainer || !skeletonWrap) return;
      openResults();
      skeletonWrap.style.display = "block";
      skeletonWrap.classList.add("is-active");
    }
    function hideSkeleton() {
      if (!skeletonWrap) return;
      skeletonWrap.classList.remove("is-active");
      skeletonWrap.style.display = "none";
    }

    function getField(key) {
      return document.getElementById(key) || document.querySelector(`[name="${key}"]`);
    }
    function setFieldValue(key, val) {
      const f = getField(key);
      if (f) f.value = val ?? "";
    }
    function getFieldValue(key) {
      const f = getField(key);
      return (f?.value || "").trim();
    }

    function showEl(el) {
      if (!el) return;
      el.style.display = "block";
      el.style.opacity = "1";
      el.style.visibility = "visible";
    }
    function hideEl(el) {
      if (!el) return;
      el.style.display = "none";
    }

    function showValLoading(msg) {
      if (valResults) valResults.style.display = "none";
      if (valLoading) valLoading.style.display = "block";
      if (valStatus && msg) valStatus.textContent = msg;
    }
    function showValResults() {
      if (valLoading) valLoading.style.display = "none";
      if (valResults) valResults.style.display = "block";
    }

    function buildFullAddress(addr) {
      const seen = new Set();
      const addUnique = (arr, v) => {
        const s = (v ?? "").toString().trim();
        if (!s) return;
        const key = s.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        arr.push(s);
      };

      const parts = [];
      addUnique(parts, addr?.address_line_1);
      addUnique(parts, addr?.address_line_2);
      addUnique(parts, addr?.town);
      addUnique(parts, addr?.county);
      addUnique(parts, formatUKPostcode(addr?.postcode || ""));

      return parts.join(", ");
    }

    /* ==============================
       3 EQUAL COLOUR THIRDS (CSS ONLY)
    ============================== */
    function injectEqualThirdsTrackCSS() {
      if (document.getElementById("moov-confidence-thirds-css")) return;

      const css = `
        [data-bar-bg="true"],
        [data-bar-bg],
        .confidence-bar-bg {
          background: linear-gradient(
            to right,
            ${SCORE_COLORS.LOW} 0%,
            ${SCORE_COLORS.LOW} 33.333%,
            ${SCORE_COLORS.MEDIUM} 33.333%,
            ${SCORE_COLORS.MEDIUM} 66.666%,
            ${SCORE_COLORS.HIGH} 66.666%,
            ${SCORE_COLORS.HIGH} 100%
          ) !important;
        }
      `.trim();

      const style = document.createElement("style");
      style.id = "moov-confidence-thirds-css";
      style.textContent = css;
      document.head.appendChild(style);
    }

    /* ==============================
       MONTH LABELS (ASAP + next months)
       - ASAP stays "ASAP" in UI; cards after it become next months
    ============================== */
    (function setupMoveDateCards() {
      const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      const nowIdx = new Date().getMonth();

      // Keep ASAP card as ASAP value; store real month if you ever want it
      const asapCard = document.querySelector('[data-name="move-date"][data-value="ASAP"]') || null;
      if (asapCard) asapCard.dataset.realMonth = months[nowIdx];

      // Cards that you want to relabel as next months
      const monthCards = document.querySelectorAll('[data-month-label="true"]');
      monthCards.forEach((card, i) => {
        const idx = (nowIdx + (i + 1)) % 12;
        const monthName = months[idx];

        const labelEl = card.querySelector(".option-card-label") || card;
        if (labelEl) labelEl.textContent = monthName;

        card.setAttribute("data-name", "move-date");
        card.setAttribute("data-value", monthName);
      });
    })();

    /* ==============================
       PLACEHOLDER IMAGE CONTROL + SHIMMER
    ============================== */
    function getAllValuationImgs() {
      return Array.from(document.querySelectorAll('img[data-valuation-image="true"]'));
    }

    function setImageShimmerLoading(isLoading) {
      document
        .querySelectorAll(".step_property_image-wrap, .image_address-wrap")
        .forEach((wrap) => wrap.classList.toggle("is-loading", !!isLoading));
    }

    function capturePlaceholdersOnce() {
      const imgs = getAllValuationImgs();
      imgs.forEach((img) => {
        if (!img) return;
        const bestSrc = img.currentSrc || img.src || img.getAttribute("src") || "";
        if (!img.dataset.placeholderSrc) img.dataset.placeholderSrc = bestSrc;
        img.loading = "eager";
        img.decoding = "async";
      });
    }

    function resetImgsToPlaceholder() {
      const imgs = getAllValuationImgs();
      imgs.forEach((img) => {
        if (!img) return;

        const bestSrc = img.dataset.placeholderSrc || img.currentSrc || img.src || img.getAttribute("src") || "";
        if (!img.dataset.placeholderSrc) img.dataset.placeholderSrc = bestSrc;

        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
        if (img.dataset.placeholderSrc) {
          img.src = img.dataset.placeholderSrc;
          img.srcset = img.dataset.placeholderSrc;
        }
      });
    }

    function applyStreetViewToImgs(streetUrl, runId) {
      if (!streetUrl) return;

      const imgs = getAllValuationImgs();
      if (!imgs.length) return;

      const url = streetUrl + (streetUrl.includes("?") ? "&" : "?") + "cb=" + encodeURIComponent(String(runId));

      const tester = new Image();
      tester.onload = () => {
        if (runId !== flowRunId) return;

        imgs.forEach((img) => {
          if (!img) return;
          img.removeAttribute("srcset");
          img.removeAttribute("sizes");
          img.src = url;
          img.srcset = url;
        });

        setImageShimmerLoading(false);
      };

      tester.onerror = () => {};
      tester.src = url;
    }

    function looksLikeStreetViewUrl(s) {
      if (!s || typeof s !== "string") return false;
      return s.includes("maps.googleapis.com/maps/api/streetview");
    }

    function findFirstStreetViewUrlDeep(obj, depth = 0) {
      if (!obj || depth > 6) return "";
      if (typeof obj === "string") return looksLikeStreetViewUrl(obj) ? obj : "";
      if (Array.isArray(obj)) {
        for (const v of obj) {
          const found = findFirstStreetViewUrlDeep(v, depth + 1);
          if (found) return found;
        }
        return "";
      }
      if (typeof obj === "object") {
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          const found = findFirstStreetViewUrlDeep(v, depth + 1);
          if (found) return found;
        }
      }
      return "";
    }

    function pickStreetUrlFromResponse(data) {
      const direct =
        data?.streetViewUrl ||
        data?.streetView?.url ||
        data?.streetView?.imageUrl ||
        data?.streetView?.streetViewUrl ||
        data?.streetViewURL ||
        "";

      if (looksLikeStreetViewUrl(direct)) return direct;

      const deep = findFirstStreetViewUrlDeep(data);
      return deep || "";
    }

    /* ==============================
       CONFIDENCE UI (animated)
    ============================== */
    function getColorFromScore(cs) {
      if (cs >= CONFIDENCE_HIGH_MIN) return SCORE_COLORS.HIGH;
      if (cs >= CONFIDENCE_MED_MIN) return SCORE_COLORS.MEDIUM;
      return SCORE_COLORS.LOW;
    }

    function getLabelFromScore(cs) {
      if (cs >= CONFIDENCE_HIGH_MIN) return "High confidence";
      if (cs >= CONFIDENCE_MED_MIN) return "Medium confidence";
      return "Low confidence";
    }

    function updateConfidenceUI(confScore) {
      const cs = isFinite(confScore) ? Math.max(0, Math.min(100, Number(confScore))) : 0;

      injectEqualThirdsTrackCSS();

      const markerColor = getColorFromScore(cs);
      const labelNice = getLabelFromScore(cs);

      if (outputConfTextEls && outputConfTextEls.length) {
        outputConfTextEls.forEach((el) => {
          if (el) el.textContent = `${Math.round(cs)}/100 - ${labelNice}`;
        });
      }

      const fills = document.querySelectorAll('[data-bar-fill="true"], [data-bar-fill]');
      const markers = document.querySelectorAll('[data-bar-marker="true"], [data-bar-marker]');
      const confFill = document.querySelectorAll('[data-conf-fill="true"], [data-conf-fill]');
      const tooltips = document.querySelectorAll('[data-confidence-tooltip="true"]');

      const animateWidth = (el) => {
        el.style.transform = "none";
        el.style.transformOrigin = "left center";
        el.style.transition = `width ${ANIM_MS}ms ease`;
        el.style.width = "0%";
        requestAnimationFrame(() => {
          el.style.width = cs + "%";
        });
      };

      fills.forEach((el) => {
        if (el) animateWidth(el);
      });
      confFill.forEach((el) => {
        if (el) animateWidth(el);
      });

      markers.forEach((m) => {
        if (!m) return;

        m.style.transition = `left ${ANIM_MS}ms ease`;
        m.style.left = "0%";
        m.style.transform = "translateX(-50%)";
        m.style.willChange = "left, transform";
        m.style.color = markerColor;

        requestAnimationFrame(() => {
          m.style.left = cs + "%";
        });
      });

      tooltips.forEach((t) => {
        if (!t) return;

        t.style.transition = `left ${ANIM_MS}ms ease`;
        t.style.left = "0%";
        t.style.transform = "translateX(-50%)";
        t.style.pointerEvents = "none";
        t.style.color = markerColor;

        requestAnimationFrame(() => {
          t.style.left = cs + "%";
        });
      });
    }

    function triggerConfidenceAnimationIfReady() {
      if (hasAnimatedConfidenceForRun) return;
      if (!pendingConfidence) return;

      const stepVal = steps["step-valuation"];
      if (!stepVal || stepVal.style.display !== "block") return;

      hasAnimatedConfidenceForRun = true;

      updateConfidenceUI(0);

      // force layout
      stepVal.offsetHeight;

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          updateConfidenceUI(pendingConfidence.score);
        });
      });
    }

    /* ==============================
       CUSTOM SCROLLBAR (optional)
    ============================== */
    function setupCustomScrollbar() {
      if (!resultsList || !scrollTrack || !scrollThumb) return;

      const MIN_THUMB_PX = 28;
      const EDGE_GAP_PX = 10;

      function clamp(n, min, max) {
        return Math.max(min, Math.min(max, n));
      }

      function getEffectiveTrackHeight() {
        const rect = scrollTrack.getBoundingClientRect();
        const h = rect.height - EDGE_GAP_PX * 2;
        return Math.max(0, h);
      }

      function updateThumbSize() {
        const scrollH = resultsList.scrollHeight;
        const clientH = resultsList.clientHeight;
        const trackH = getEffectiveTrackHeight();
        if (!trackH) return;

        if (scrollH <= clientH) {
          scrollThumb.style.height = trackH + "px";
          scrollThumb.style.transform = `translateY(${EDGE_GAP_PX}px)`;
          return;
        }

        const ratio = clientH / scrollH;
        const h = clamp(Math.round(trackH * ratio), MIN_THUMB_PX, trackH);
        scrollThumb.style.height = h + "px";
      }

      function syncThumbToScroll() {
        const scrollH = resultsList.scrollHeight;
        const clientH = resultsList.clientHeight;
        const trackH = getEffectiveTrackHeight();
        if (!trackH) return;

        if (scrollH <= clientH) {
          scrollThumb.style.transform = `translateY(${EDGE_GAP_PX}px)`;
          return;
        }

        const thumbH = scrollThumb.offsetHeight;
        const maxScrollTop = scrollH - clientH;
        const maxThumbTop = trackH - thumbH;

        const ratio = maxScrollTop ? resultsList.scrollTop / maxScrollTop : 0;
        const y = EDGE_GAP_PX + ratio * maxThumbTop;

        scrollThumb.style.transform = `translateY(${y}px)`;
      }

      function refresh() {
        updateThumbSize();
        syncThumbToScroll();
      }

      resultsList.addEventListener("scroll", syncThumbToScroll, { passive: true });
      window.addEventListener("resize", refresh);

      const mo = new MutationObserver(() => refresh());
      mo.observe(resultsList, { childList: true, subtree: true });

      let dragging = false;
      let startY = 0;
      let startScrollTop = 0;

      function onPointerDown(e) {
        dragging = true;
        startY = e.clientY;
        startScrollTop = resultsList.scrollTop;
        scrollThumb.setPointerCapture?.(e.pointerId);
        document.body.style.userSelect = "none";
      }
      function onPointerMove(e) {
        if (!dragging) return;

        const scrollH = resultsList.scrollHeight;
        const clientH = resultsList.clientHeight;
        const trackH = getEffectiveTrackHeight();
        if (!trackH || scrollH <= clientH) return;

        const thumbH = scrollThumb.offsetHeight;
        const maxScrollTop = scrollH - clientH;
        const maxThumbTop = trackH - thumbH;

        const dy = e.clientY - startY;
        const scrollDelta = (dy / maxThumbTop) * maxScrollTop;
        resultsList.scrollTop = startScrollTop + scrollDelta;
      }
      function onPointerUp() {
        dragging = false;
        document.body.style.userSelect = "";
      }

      scrollThumb.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        onPointerDown(e);
      });

      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerup", onPointerUp, { passive: true });
      window.addEventListener("pointercancel", onPointerUp, { passive: true });

      const refreshNow = () => {
        updateThumbSize();
        syncThumbToScroll();
      };
      refreshNow();
      return refreshNow;
    }

    const refreshScrollbar = setupCustomScrollbar();

    /* ==============================
       INIT
    ============================== */
    hideError();
    setOfferBtnEnabled(false);
    closeResults();
    hideSkeleton();

    if (multistepWrapper) multistepWrapper.style.display = "none";

    Object.values(steps).forEach((s) => {
      if (!s) return;
      s.classList.remove("active");
      s.style.display = "none";
    });

    hideEl(highWrap);
    hideEl(lowWrap);

    capturePlaceholdersOnce();
    injectEqualThirdsTrackCSS();

    /* ==============================
       STEP SYSTEM + BACK
    ============================== */
    const stepHistory = [];

    function forceReflow(el) {
      if (!el) return;
      el.offsetHeight;
    }

    function showStep(name) {
      Object.values(steps).forEach((s) => {
        if (!s) return;
        s.classList.remove("active");
        s.style.display = "none";
      });

      const target = steps[name];
      if (!target) return;

      target.style.display = "block";
      forceReflow(target);

      if (name === "step-valuation") {
        setTimeout(() => {
          forceReflow(target);
          triggerConfidenceAnimationIfReady();
        }, 60);
      }

      setTimeout(() => target.classList.add("active"), 20);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function goToStep(name) {
      if (stepHistory[stepHistory.length - 1] !== name) stepHistory.push(name);
      showStep(name);
    }

    function goBack() {
      if (valuationAbortController) {
        try {
          valuationAbortController.abort();
        } catch (e) {}
        valuationAbortController = null;
      }
      if (resolveAbortController) {
        try {
          resolveAbortController.abort();
        } catch (e) {}
        resolveAbortController = null;
      }
      if (stepHistory.length > 1) {
        stepHistory.pop();
        showStep(stepHistory[stepHistory.length - 1]);
      }
    }

    document.addEventListener("click", (e) => {
      const backBtn = e.target.closest(".js-back");
      if (!backBtn) return;
      e.preventDefault();
      goBack();
    });

    /* ==============================
       OPTION CARDS (step navigation)
    ============================== */
    document.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-name]");
      if (!opt) return;

      const name = opt.getAttribute("data-name");
      let value = opt.getAttribute("data-value");

      if (!value) {
        const labelEl = opt.querySelector(".option-card-label");
        value = (labelEl ? labelEl.textContent : opt.textContent || "").trim();
      }

      setFieldValue(name, value);

      if (name === "move-date") return goToStep("step-2");

      if (name === "selling-reason") {
        if (value === "Buying onwards") return goToStep("step-3a");
        if (value === "Relocating") return goToStep("step-3b");
        if (value === "Landlord exiting investment") return goToStep("step-3c");
        return goToStep("step-worth");
      }

      if (name === "next-home" || name === "relocation" || name === "tenanted") {
        return goToStep("step-worth");
      }
    });

    /* ==============================
       DROPDOWN: ADDRESS SEARCH
    ============================== */
    let searchTimer = null;
    let lastSearchKey = "";

    async function fetchAddressesByPostcode(postcodeRaw) {
      const pcNorm = normalizePostcode(postcodeRaw);
      if (pcNorm.length < 5) return null;
      if (pcNorm === lastSearchKey) return null;
      lastSearchKey = pcNorm;

      try {
        return await postJSON(`${apiAddressBase}/api/address/search`, {
          postcode: formatUKPostcode(pcNorm),
        });
      } catch {
        return { error: true };
      }
    }

    function renderResults(addresses) {
      hideSkeleton();
      clearResults();

      if (!Array.isArray(addresses) || addresses.length === 0) {
        closeResults();
        return;
      }

      addresses.forEach((a) => {
        const item = document.createElement("div");
        item.className = "result-item";
        item.setAttribute("role", "button");
        item.setAttribute("tabindex", "0");

        item.dataset.uprn = a.uprn || "";
        item.dataset.line1 = a.line_1 || "";
        item.dataset.postcode = a.postcode || "";
        item.dataset.display = a.display || "";

        item.textContent = a.display || a.line_1 || "Address";
        resultsList?.appendChild(item);
      });

      openResults();
      if (typeof refreshScrollbar === "function") requestAnimationFrame(() => refreshScrollbar());
    }

    input?.addEventListener("input", () => {
      hideError();
      clearSelection();
      clearResults();
      closeResults();

      const val = (input.value || "").trim();
      const pcNorm = normalizePostcode(val);

      if (!pcNorm) {
        lastSearchKey = "";
        hideSkeleton();
        return;
      }

      if (pcNorm.length >= 4) showSkeleton();
      else hideSkeleton();

      if (pcNorm.length < 5) return;

      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const data = await fetchAddressesByPostcode(val);
        if (!data) return;

        if (data.error) {
          hideSkeleton();
          showError("Could not search addresses. Please try again.");
          return;
        }

        renderResults(data.addresses || []);
      }, 250);
    });

    document.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".result-item");
      if (!item) return;

      e.preventDefault();
      hideError();
      hideSkeleton();

      document.querySelectorAll(".result-item.is-selected").forEach((el) => el.classList.remove("is-selected"));
      item.classList.add("is-selected");

      selectedAddress = {
        uprn: item.dataset.uprn || "",
        line_1: item.dataset.line1 || "",
        postcode: item.dataset.postcode || "",
        display: item.dataset.display || item.textContent || "",
      };

      if (input) input.value = selectedAddress.display;

      setOfferBtnEnabled(true);
      clearResults();
      closeResults();
    });

    document.addEventListener("click", (e) => {
      const insideDropdown = e.target.closest(".results-container");
      const insideInput = e.target.closest("#address-search");
      if (!insideDropdown && !insideInput) {
        closeResults();
        hideSkeleton();
      }
    });

    input?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!selectedAddress) {
        showError("Please select an address from the list.");
        return;
      }
      btn?.click();
    });

    /* ==============================
       SEE OFFER -> RESOLVE
    ============================== */
    btn?.addEventListener("click", async (e) => {
      e.preventDefault();
      hideError();

      if (!selectedAddress) {
        showError("Please select an address from the list.");
        return;
      }

      const postcode = selectedAddress.postcode || "";
      const houseNumber = extractHouseNumber(selectedAddress.line_1);

      if (!postcode || !houseNumber) {
        showError("Please select a valid address.");
        return;
      }

      const myRunId = ++flowRunId;

      valuationCompleteForRun = false;
      valuationStarted = false;
      pendingConfidence = null;
      hasAnimatedConfidenceForRun = false;

      if (resolveAbortController) {
        try {
          resolveAbortController.abort();
        } catch (e) {}
      }
      resolveAbortController = new AbortController();

      if (valuationAbortController) {
        try {
          valuationAbortController.abort();
        } catch (e) {}
        valuationAbortController = null;
      }

      capturePlaceholdersOnce();
      resetImgsToPlaceholder();
      setImageShimmerLoading(true);

      if (popup) popup.style.display = "none";

      if (multistepWrapper) multistepWrapper.style.display = "block";
      if (mainWrapper) {
        mainWrapper.style.opacity = "0";
        setTimeout(() => (mainWrapper.style.display = "none"), 250);
      }

      hideEl(highWrap);
      hideEl(lowWrap);

      updateConfidenceUI(0);

      goToStep("step-1");
      outputAddressEls.forEach((el) => (el.textContent = ""));

      try {
        resolvedAddress = await postJSON(
          `${apiAddressBase}/api/address/resolve`,
          {
            postcode: formatUKPostcode(postcode),
            houseNumber,
          },
          { signal: resolveAbortController.signal }
        );

        if (myRunId !== flowRunId) return;

        const fullAddressText = buildFullAddress(resolvedAddress);
        outputAddressEls.forEach((el) => {
          el.textContent = fullAddressText;
        });

        if (!getFieldValue("property-type")) {
          setFieldValue("property-type", inferPropertyTypeFromAddressLine(resolvedAddress.address_line_1));
        }

        if (!valuationStarted) {
          valuationStarted = true;

          const earlyPayload = {
            addressId: resolvedAddress?.id,
            addressLine1: resolvedAddress?.address_line_1,
            postcode: formatUKPostcode(resolvedAddress?.postcode),
            propertyType:
              getFieldValue("property-type") || inferPropertyTypeFromAddressLine(resolvedAddress?.address_line_1),
            saleTimeline: "16+_weeks",
            reasonForSelling: "Unknown",
            source: "webflow",
            consent: true,
          };

          startValuation(earlyPayload, myRunId);
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;

        alert("Address could not be resolved.");
        if (multistepWrapper) multistepWrapper.style.display = "none";
        if (mainWrapper) {
          mainWrapper.style.display = "block";
          mainWrapper.style.opacity = "1";
        }
      }
    });

    /* ==============================
       WORTH STEP
    ============================== */
    (function setupWorthStep() {
      const worthStep = steps["step-worth"];
      if (!worthStep) return;

      const worthBtn = worthStep.querySelector(".button.continue");
      const worthInput = document.querySelector("input[data-worth-input]");
      const notSureRow = worthStep.querySelector('[data-worth-not-sure="true"]');

      if (!worthBtn || !worthInput) return;

      const digitsOnly = (v) => (v || "").replace(/\D/g, "");
      const isNotSureOn = () => notSureRow?.getAttribute("data-checked") === "true";

      function isWorthValid() {
        return digitsOnly(worthInput.value).length > 0 || isNotSureOn();
      }

      function syncHidden() {
        const digits = digitsOnly(worthInput.value);
        setFieldValue("worth_estimate", digits ? digits : "");
        setFieldValue("worth_not_sure", isNotSureOn() ? "true" : "false");
      }

      function updateBtn() {
        const ok = isWorthValid();
        worthBtn.classList.toggle("is-disabled", !ok);
        worthBtn.setAttribute("aria-disabled", ok ? "false" : "true");
        syncHidden();
      }

      updateBtn();
      worthInput.addEventListener("input", updateBtn);
      worthInput.addEventListener("blur", updateBtn);

      document.addEventListener("click", (e) => {
        if (e.target.closest('[data-worth-not-sure="true"]')) {
          setTimeout(updateBtn, 0);
        }
      });

      worthBtn.addEventListener("click", (e) => {
        e.preventDefault();
        updateBtn();
        if (!isWorthValid()) return;
        goToStep("step-4");
      });
    })();

    /* ==============================
       SUBMIT LOCK
    ============================== */
    document.addEventListener(
      "submit",
      function (e) {
        const form = e.target;
        if (form && form.id === "wf-form-step4" && !form.classList.contains("allow-webflow-submit")) {
          e.preventDefault();
        }
      },
      true
    );

    /* ==============================
       VALUATION
    ============================== */
    function parseConfidence(data) {
      const rawScore =
        data?.confidence?.score ?? data?.confidenceScore ?? data?.confidence ?? data?.confidence_score ?? data?.score ?? "";

      const parsedScore = (() => {
        if (typeof rawScore === "number") return rawScore;
        const s = String(rawScore);
        const m = s.match(/(\d+(\.\d+)?)/);
        return m ? Number(m[1]) : NaN;
      })();

      const confScore = isFinite(parsedScore) ? Math.max(0, Math.min(100, parsedScore)) : 0;
      const confLabel = (data?.confidence?.label ?? data?.confidenceLabel ?? "").toString();
      return { confScore, confLabel };
    }

    function startValuation(payload, runId) {
      if (valuationAbortController) {
        try {
          valuationAbortController.abort();
        } catch (e) {}
        valuationAbortController = null;
      }

      const controller = new AbortController();
      valuationAbortController = controller;

      const timeoutMs = 25000;
      const t = setTimeout(() => {
        try {
          controller.abort();
        } catch (e) {}
      }, timeoutMs);

      fetch(apiValuation, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(async (r) => {
          clearTimeout(t);
          if (!r.ok) throw new Error("Valuation failed");
          return r.json();
        })
        .then((data) => {
          if (runId !== flowRunId) return;

          valuationCompleteForRun = true;

          const { confScore, confLabel } = parseConfidence(data);
          pendingConfidence = { score: confScore, label: confLabel };

          // Street view even for deskReview
          const streetUrl = pickStreetUrlFromResponse(data);
          if (streetUrl) applyStreetViewToImgs(streetUrl, runId);

          const deskReview = data?.deskReview === true;

          // Tim: Market Value Range (±5%) -> low to high
          const mvLow = data?.marketValue?.low ?? 0;
          const mvHigh = data?.marketValue?.high ?? 0;
          const mvCentral = data?.marketValue?.central ?? data?.marketValue ?? data?.valuation?.mid ?? 0;

          const marketRangeText = mvLow && mvHigh ? `${money(mvLow)} - ${money(mvHigh)}` : "";

          // Tim: Moov Offer Range -> offers.fastTrack.low/high
          const offerLow = data?.offers?.fastTrack?.low ?? 0;
          const offerHigh = data?.offers?.fastTrack?.high ?? 0;
          const offerRangeText = offerLow && offerHigh ? `${money(offerLow)} - ${money(offerHigh)}` : "";

          // Fill outputs that exist on the page
          if (outputPrice) outputPrice.textContent = marketRangeText || ""; // MARKET VALUE RANGE (low-high)
          if (outputEstimated) outputEstimated.textContent = money(mvCentral) || ""; // estimated (central)
          if (outputRange) outputRange.textContent = offerRangeText || ""; // MOOV OFFER RANGE

          // Valid until +30d
          if (outputDate) {
            const validUntil = new Date();
            validUntil.setHours(12, 0, 0, 0);
            validUntil.setDate(validUntil.getDate() + 30);
            outputDate.textContent = validUntil.toLocaleDateString("en-GB");
          }

          // Show correct wrap
          if (deskReview) {
            hideEl(highWrap);
            showEl(lowWrap);
          } else {
            showEl(highWrap);
            hideEl(lowWrap);
          }

          showValResults();
          triggerConfidenceAnimationIfReady();
          valuationAbortController = null;
        })
        .catch((err) => {
          clearTimeout(t);
          if (err && err.name === "AbortError") return;

          console.error(err);

          hideEl(highWrap);
          showEl(lowWrap);

          pendingConfidence = { score: 0, label: "LOW" };

          showValResults();
          triggerConfidenceAnimationIfReady();
          valuationAbortController = null;
        });
    }

    /* ==============================
       STEP4 SUBMIT -> FINAL STEP
    ============================== */
    step4Form?.addEventListener("submit", async (e) => {
      if (!step4Form.classList.contains("allow-webflow-submit")) e.preventDefault();
      hideError();

      const requiredCheckbox = step4Form.querySelector("input[type='checkbox'][required]");
      if (requiredCheckbox && !requiredCheckbox.checked) {
        alert("Please agree to the Terms and Privacy Policy.");
        return;
      }

      if (!getFieldValue("move-date") || !getFieldValue("selling-reason")) {
        alert("Please complete all questions before submitting.");
        return;
      }

      if (!getFieldValue("property-type")) {
        setFieldValue(
          "property-type",
          inferPropertyTypeFromAddressLine(resolvedAddress?.address_line_1 || selectedAddress?.line_1 || "")
        );
      }

      const step4 = steps["step-4"];
      if (step4) {
        step4.classList.remove("active");
        step4.style.display = "none";
      }

      goToStep("step-valuation");

      if (!valuationCompleteForRun) {
        showValLoading("Loading your valuation…");
      } else {
        showValResults();
      }

      setTimeout(() => {
        step4Form.classList.add("allow-webflow-submit");

        if (typeof step4Form.requestSubmit === "function") {
          step4Form.requestSubmit();
        } else {
          const submitBtn = step4Form.querySelector('[type="submit"]');
          if (submitBtn) submitBtn.click();
          else step4Form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }

        step4Form.classList.remove("allow-webflow-submit");
      }, 300);
    });
  }

  // Safe init no matter how/when the script loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMoov);
  } else {
    initMoov();
  }
})();

/* =========================================================
   CALENDLY INLINE EMBED + PREFILL (external JS-safe)
   - Requires Calendly loader in <head>:
     <script src="https://assets.calendly.com/assets/external/widget.js" async></script>
   ========================================================= */

(function () {
  "use strict";

  const EVENT_URL = "https://calendly.com/moovhomes/new-meeting";
  const SLOT_ID = "calendly-modal-slot";

  // Webflow input selectors (ne mijenjaš ih)
  const SELECTORS = {
    first: "#First-name",
    last: "#Last-name",
    email: 'input[type="email"]',
    phone: "#Telephone-or-mobile-number",
  };

  function getVal(sel) {
    return document.querySelector(sel)?.value?.trim() || "";
  }

  function cleanPhone(raw) {
    return (raw || "").trim().replace(/[^\d+]/g, "");
  }

  // UK normalize:
  // 07888...   -> +447888...
  // +44 7888.. -> +447888...
  // 447888...  -> +447888...
  function normalizeUKPhone(raw) {
    let p = cleanPhone(raw);
    if (!p) return "";

    if (p.startsWith("+44")) {
      if (p.startsWith("+440")) p = "+44" + p.slice(4);
      return p;
    }

    if (p.startsWith("44")) {
      p = "+44" + p.slice(2);
      if (p.startsWith("+440")) p = "+44" + p.slice(4);
      return p;
    }

    if (p.startsWith("0")) {
      p = "+44" + p.slice(1);
      return p;
    }

    if (p.startsWith("7")) {
      p = "+44" + p;
      return p;
    }

    return p;
  }

  function buildPrefill() {
    const first = getVal(SELECTORS.first);
    const last = getVal(SELECTORS.last);
    const email = getVal(SELECTORS.email);

    const phoneRaw = getVal(SELECTORS.phone);
    const phone = normalizeUKPhone(phoneRaw);

    const fullName = `${first} ${last}`.trim();

    const prefill = {
      name: fullName,
      email: email,
    };

    // Phone works only if Calendly event has a custom question with key a1
    if (phone) {
      prefill.customAnswers = { a1: phone };
    }

    return prefill;
  }

  function renderCalendly() {
    const slot = document.getElementById(SLOT_ID);
    if (!slot || !window.Calendly) return;

    slot.innerHTML = "";

    window.Calendly.initInlineWidget({
      url: EVENT_URL,
      parentElement: slot,
      prefill: buildPrefill(),
    });
  }

  function openCalendly() {
    if (window.Calendly) {
      renderCalendly();
      return;
    }

    let tries = 0;
    const timer = setInterval(function () {
      tries++;

      if (window.Calendly) {
        clearInterval(timer);
        renderCalendly();
      }

      if (tries > 50) clearInterval(timer);
    }, 100);
  }

  document.addEventListener("click", function (e) {
    const btn = e.target.closest('[data-open-calendly="true"]');
    if (!btn) return;

    setTimeout(openCalendly, 200);
  });
})();


/* ============================
   HUBSPOT DUAL SUBMIT (Moov)
   - Sends Webflow submission to HubSpot (backend ingestion)
   - Does NOT block Webflow submit
   - Uses HS v3 endpoint
============================ */
(function hubspotDualSubmitMoov() {
  const PORTAL_ID = "14719287";
  const FORM_GUID = "dcb4bb33-377b-4e77-a5d1-4d3689acc5ff";

  const ENDPOINT = `https://api.hsforms.com/submissions/v3/integration/submit/${encodeURIComponent(
    PORTAL_ID
  )}/${encodeURIComponent(FORM_GUID)}`;

  // OPTIONAL:
  // Map DISPLAY labels (your UI) -> HubSpot INTERNAL VALUES (property option "value")
  // If you leave this empty, we fallback to sending the UI value.
  const MAP = {
    move_timeframe: {
      // "ASAP": "asap",
      // "February": "february",
    },
    moov_reason_for_sale_submitted: {
      // "Buying onwards": "buying_onwards",
      // "Relocating": "relocating",
      // "Landlord exiting investment": "landlord_exiting_investment",
    },
    moov_next_home_status_submitted: {
      // "Yes": "yes",
      // "No": "no",
      // "Not sure": "not_sure",
    },
    moov_relocation_work_related_submitted: {
      // "Yes": "yes",
      // "No": "no",
    },
    property_currently_tenanted_submitted: {
      // "Yes": "yes",
      // "No": "no",
    },
  };

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
    return m ? decodeURIComponent(m[2]) : "";
  }

  function safeNum(v) {
    if (v === undefined || v === null) return "";
    const n = Number(String(v).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : "";
  }

  function getInputVal(formEl, key) {
    return (
      formEl.querySelector(`#${CSS.escape(key)}`)?.value?.trim() ||
      formEl.querySelector(`[name="${key}"]`)?.value?.trim() ||
      ""
    );
  }

  function getText(sel) {
    return document.querySelector(sel)?.textContent?.trim() || "";
  }

  function parseRange(text) {
    const nums = (text || "").match(/[\d,]+/g) || [];
    const a = nums[0] ? Number(nums[0].replace(/,/g, "")) : "";
    const b = nums[1] ? Number(nums[1].replace(/,/g, "")) : "";
    return { a, b };
  }

  function parseConfidenceBand(text) {
    const t = (text || "").toLowerCase();
    if (t.includes("high")) return "high";
    if (t.includes("medium")) return "medium";
    if (t.includes("low")) return "low";
    return "";
  }

  function mapDropdown(propInternalName, uiValue) {
    const table = MAP[propInternalName] || {};
    // ✅ if mapped -> send mapped internal value
    if (uiValue && table[uiValue]) return table[uiValue];

    // ✅ fallback (no extra questions needed)
    // NOTE: If HubSpot requires internal option values strictly, they must provide them.
    return uiValue || "";
  }

  function buildFields(formEl) {
    // Contact details (standard HS property names)
    const firstname = formEl.querySelector("#First-name")?.value?.trim() || "";
    const lastname  = formEl.querySelector("#Last-name")?.value?.trim() || "";
    const email     = formEl.querySelector('input[type="email"]')?.value?.trim() || "";
    const phone     = formEl.querySelector("#Telephone-or-mobile-number")?.value?.trim() || "";

    // Hidden fields (your UI values)
    const moveUI   = getInputVal(formEl, "move-date");
    const reasonUI = getInputVal(formEl, "selling-reason");
    const nextHomeUI = getInputVal(formEl, "next-home");
    const relocUI    = getInputVal(formEl, "relocation");
    const tenantedUI = getInputVal(formEl, "tenanted");

    const ownerEstimate = safeNum(getInputVal(formEl, "worth_estimate"));
    const ownerNotSure  = (getInputVal(formEl, "worth_not_sure") || "").toLowerCase() === "true";

    // Outputs (from UI)
    const marketRangeText = getText("[data-valuation-price='true']");
    const offerRangeText  = getText("[data-offer-range='true']");
    const validUntilText  = getText("[data-valuation-date='true']");
    const estimatedText   = getText("[data-valuation-estimated='true']");
    const confText        = getText('[data-confidence-score="true"]');

    const mv = parseRange(marketRangeText);
    const off = parseRange(offerRangeText);

    const confScoreMatch = (confText || "").match(/(\d+)\s*\/\s*100/i);
    const confScore = confScoreMatch ? Number(confScoreMatch[1]) : "";
    const confBand = parseConfidenceBand(confText);

    const fields = [
      { name: "firstname", value: firstname },
      { name: "lastname", value: lastname },
      { name: "email", value: email },
      { name: "phone", value: phone },

      // Q1/Q2
      { name: "move_timeframe", value: mapDropdown("move_timeframe", moveUI) },
      { name: "moov_reason_for_sale_submitted", value: mapDropdown("moov_reason_for_sale_submitted", reasonUI) },

      // Q3 conditional (only one will realistically have value)
      { name: "moov_next_home_status_submitted", value: mapDropdown("moov_next_home_status_submitted", nextHomeUI) },
      { name: "moov_relocation_work_related_submitted", value: mapDropdown("moov_relocation_work_related_submitted", relocUI) },
      { name: "property_currently_tenanted_submitted", value: mapDropdown("property_currently_tenanted_submitted", tenantedUI) },

      // Q4
      { name: "moov_owner_estimate_value_submitted", value: ownerEstimate === "" ? "" : String(ownerEstimate) },
      { name: "moov_owner_estimate_not_sure_submitted", value: ownerNotSure ? "true" : "false" },

      // Valuation outputs
      { name: "moov_cons_valuation_submitted", value: safeNum(estimatedText) === "" ? "" : String(safeNum(estimatedText)) },
      { name: "moov_market_value_low_submitted", value: mv.a === "" ? "" : String(mv.a) },
      { name: "moov_market_value_high_submitted", value: mv.b === "" ? "" : String(mv.b) },

      { name: "moov_confidence_score_submitted", value: confScore === "" ? "" : String(confScore) },
      { name: "moov_confidence_band_submitted", value: confBand },

      { name: "moov_offer_low_submitted", value: off.a === "" ? "" : String(off.a) },
      { name: "moov_offer_high_submitted", value: off.b === "" ? "" : String(off.b) },

      { name: "moov_offer_valid_until_submitted", value: validUntilText },
    ];

    return fields.filter(f => f.value !== "");
  }

  async function submitToHubSpot(formEl) {
    try {
      const hutk = getCookie("hubspotutk");

      const body = {
        submittedAt: Date.now(),
        fields: buildFields(formEl),
        context: {
          hutk: hutk || undefined,
          pageUri: window.location.href,
          pageName: document.title,
        },
      };

      // fire & forget (non-blocking)
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch (e) {
      console.warn("HubSpot submit failed (non-blocking):", e);
    }
  }

  // expose (optional)
  window.__moovSubmitToHubSpot = submitToHubSpot;

  // attach once (capture phase)
  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target;
      if (!form || form.id !== "wf-form-step4") return;
      submitToHubSpot(form);
    },
    true
  );
})();

