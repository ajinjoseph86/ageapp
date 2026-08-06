const state = {
  photos: [null, null, null], // File objects
};

const els = {
  slots: document.querySelectorAll('.photo-slot'),
  currentAge: document.getElementById('current-age'),
  sceneDescription: document.getElementById('scene-description'),
  ageSlider: document.getElementById('age-slider'),
  ageReadout: document.getElementById('age-readout'),
  presets: document.querySelectorAll('#age-presets button'),
  aspectRatio: document.getElementById('aspect-ratio'),
  generateBtn: document.getElementById('generate-btn'),
  generateBtnText: document.getElementById('generate-btn-text'),
  costBadge: document.getElementById('cost-badge'),
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
    els.costBadge.textContent = `~$${data.costPerGenerationUsd.toFixed(3)}`;
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
    const filename = `age-${entry.targetAge}-${entry.id ? entry.id.slice(0, 8) : Date.now()}.png`;
    item.innerHTML = `
      <img src="${entry.resultUrl}" alt="Age ${entry.targetAge}" />
      <span class="tag">Age ${entry.targetAge}</span>
      <a class="gallery-download" href="${entry.resultUrl}" download="${filename}" title="Download">&#8681;</a>
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

// ---------- generate ----------

function updateGenerateEnabled() {
  const hasPhoto = state.photos.some(Boolean);
  els.generateBtn.disabled = !hasPhoto;
}

function setLoading(isLoading) {
  els.generateBtn.disabled = isLoading || !state.photos.some(Boolean);
  els.generateBtnText.textContent = isLoading ? 'Generating…' : 'Generate';
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

  const currentAge = parseInt(els.currentAge.value, 10);
  const targetAge = parseInt(els.ageSlider.value, 10);
  if (!Number.isFinite(currentAge) || currentAge < 0 || currentAge > 120) {
    showError('Enter a valid current age.');
    return;
  }

  const formData = new FormData();
  photos.forEach((file) => formData.append('photos', file));
  formData.append('currentAge', String(currentAge));
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
    els.downloadBtn.href = data.resultUrl;
    els.downloadBtn.download = `age-${targetAge}-${Date.now()}.png`;
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

// ---------- init ----------

updateGenerateEnabled();
refreshBudget();
refreshHistory();
