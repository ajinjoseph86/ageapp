const state = {
  photos: [null, null, null], // File objects
  currentImageId: null,
};

const els = {
  slots: document.querySelectorAll('.photo-slot'),
  sceneDescription: document.getElementById('scene-description'),
  ageSlider: document.getElementById('age-slider'),
  ageReadout: document.getElementById('age-readout'),
  presets: document.querySelectorAll('#age-presets button'),
  aspectRatio: document.getElementById('aspect-ratio'),
  generateBtn: document.getElementById('generate-btn'),
  generateBtnText: document.getElementById('generate-btn-text'),
  errorText: document.getElementById('error-text'),
  previewFrame: document.getElementById('preview-frame'),
  previewPlaceholder: document.getElementById('preview-placeholder'),
  previewImage: document.getElementById('preview-image'),
  previewLoading: document.getElementById('preview-loading'),
  downloadBtn: document.getElementById('download-btn'),
  gallery: document.getElementById('gallery'),
  budgetPill: document.getElementById('budget-pill'),
  budgetText: document.getElementById('budget-text'),
};

// ---------- photo slots ----------

els.slots.forEach((slot) => {
  const index = Number(slot.dataset.index);
  const input = slot.querySelector('.photo-input');

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.innerHTML = '&times;';
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.photos[index] = null;
    input.value = '';
    const thumb = slot.querySelector('img.thumb');
    if (thumb) thumb.remove();
    slot.classList.remove('filled');
    updateGenerateEnabled();
  });
  slot.appendChild(removeBtn);

  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    state.photos[index] = file;

    let thumb = slot.querySelector('img.thumb');
    if (!thumb) {
      thumb = document.createElement('img');
      thumb.className = 'thumb';
      slot.insertBefore(thumb, removeBtn);
    }
    thumb.src = URL.createObjectURL(file);
    slot.classList.add('filled');
    updateGenerateEnabled();
  });
});

// ---------- age slider ----------

function syncAgeReadout() {
  els.ageReadout.textContent = els.ageSlider.value;
  els.presets.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.age === els.ageSlider.value);
  });
}

els.ageSlider.addEventListener('input', syncAgeReadout);

els.presets.forEach((btn) => {
  btn.addEventListener('click', () => {
    els.ageSlider.value = btn.dataset.age;
    syncAgeReadout();
  });
});

syncAgeReadout();

// ---------- budget ----------

async function refreshBudget() {
  try {
    const res = await fetch('/api/budget');
    const data = await res.json();
    els.budgetText.textContent = `$${data.remainingUsd.toFixed(2)} left of $${data.dailyBudgetUsd.toFixed(2)} today`;
    els.budgetPill.classList.toggle('low', data.remainingUsd < data.costPerGenerationUsd);
    return data;
  } catch (err) {
    els.budgetText.textContent = 'Budget unavailable';
  }
}

// ---------- gallery ----------

function renderGallery(history) {
  els.gallery.innerHTML = '';
  if (!history || history.length === 0) {
    els.gallery.innerHTML = '<p class="gallery-empty">Your generated portraits will show up here.</p>';
    return;
  }
  history.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.innerHTML = `
      <img src="${entry.resultUrl}" alt="Age ${entry.targetAge}" />
      <span class="tag">Age ${entry.targetAge}</span>
      <button class="gallery-download" data-image-id="${entry.id}" title="Pay $2.00 to download highres image">&#8681;</button>
    `;
    els.gallery.appendChild(item);
  });
}

async function refreshHistory() {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    renderGallery(history);
  } catch (err) {
    renderGallery([]);
  }
}

els.gallery.addEventListener('click', (e) => {
  const btn = e.target.closest('.gallery-download');
  if (btn) startCheckout(btn.dataset.imageId);
});

// ---------- paywall ----------

function triggerDownload(imageId) {
  const a = document.createElement('a');
  a.href = `/api/download/${imageId}`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function restorePaidPreview(imageId) {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    const entry = history.find((h) => h.id === imageId);
    if (!entry) return;

    els.previewPlaceholder.classList.add('hidden');
    els.previewImage.src = entry.resultUrl;
    els.previewImage.classList.remove('hidden');
    els.downloadBtn.classList.remove('hidden');
    state.currentImageId = entry.id;
  } catch (err) {
    // non-fatal: preview just won't be restored
  }
}

async function startCheckout(imageId) {
  if (!imageId) return;
  showError('');
  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not start checkout.');
    }
    if (data.alreadyPaid) {
      triggerDownload(imageId);
      return;
    }
    window.location.href = data.url;
  } catch (err) {
    showError(err.message || 'Could not start checkout.');
  }
}

async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const paidImage = params.get('paid_image');
  const sessionId = params.get('session_id');
  const previewImage = params.get('preview_image');

  if (paidImage && sessionId) {
    window.history.replaceState({}, '', window.location.pathname);
    try {
      const res = await fetch(`/api/verify-payment?session_id=${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      if (res.ok && data.paid) {
        await restorePaidPreview(paidImage);
        triggerDownload(paidImage);
      } else {
        showError('Payment could not be verified.');
      }
    } catch (err) {
      showError('Payment could not be verified.');
    }
    return;
  }

  if (previewImage) {
    // User cancelled checkout — just bring their preview back, no payment to verify.
    window.history.replaceState({}, '', window.location.pathname);
    await restorePaidPreview(previewImage);
  }
}

// ---------- generate ----------

function updateGenerateEnabled() {
  const hasPhoto = state.photos.some(Boolean);
  els.generateBtn.disabled = !hasPhoto;
}

function setLoading(isLoading) {
  els.generateBtn.disabled = isLoading || !state.photos.some(Boolean);
  els.generateBtnText.textContent = isLoading ? 'Timetravelling…' : 'Generate';
  els.previewLoading.classList.toggle('hidden', !isLoading);
}

function showError(message) {
  els.errorText.textContent = message || '';
}

els.generateBtn.addEventListener('click', async () => {
  showError('');
  const photos = state.photos.filter(Boolean);
  if (photos.length === 0) {
    showError('Add at least 1 photo.');
    return;
  }

  const targetAge = parseInt(els.ageSlider.value, 10);

  if (!els.sceneDescription.value.trim()) {
    showError('Add a scene/clothing description.');
    return;
  }

  const formData = new FormData();
  photos.forEach((file) => formData.append('photos', file));
  formData.append('targetAge', String(targetAge));
  formData.append('sceneDescription', els.sceneDescription.value || '');
  formData.append('aspectRatio', els.aspectRatio.value);

  setLoading(true);
  els.previewPlaceholder.classList.add('hidden');

  try {
    const res = await fetch('/api/generate', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Generation failed.');
    }

    els.previewImage.src = `${data.resultUrl}?t=${Date.now()}`;
    els.previewImage.classList.remove('hidden');
    state.currentImageId = data.id;
    els.downloadBtn.classList.remove('hidden');
    els.budgetText.textContent = `$${data.remainingTodayUsd.toFixed(2)} left of today's budget`;
    els.budgetPill.classList.toggle('low', data.remainingTodayUsd < data.costUsd);

    await refreshHistory();
  } catch (err) {
    showError(err.message || 'Something went wrong.');
    if (els.previewImage.classList.contains('hidden')) {
      els.previewPlaceholder.classList.remove('hidden');
    }
  } finally {
    setLoading(false);
  }
});

els.downloadBtn.addEventListener('click', () => startCheckout(state.currentImageId));

// ---------- init ----------

updateGenerateEnabled();
refreshBudget();
refreshHistory();
handlePaymentReturn();
