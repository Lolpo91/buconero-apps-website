(function () {
  'use strict';

  document.querySelectorAll('[data-help-accordion]').forEach((accordion) => {
    const items = Array.from(accordion.querySelectorAll('.help-accordion-item'));

    function closeItem(item) {
      const trigger = item.querySelector('.help-accordion-trigger');
      const panel = item.querySelector('.help-accordion-panel');
      if (!trigger || !panel) return;
      item.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
    }

    function openItem(item) {
      const trigger = item.querySelector('.help-accordion-trigger');
      const panel = item.querySelector('.help-accordion-panel');
      if (!trigger || !panel) return;
      items.forEach((other) => {
        if (other !== item) closeItem(other);
      });
      item.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
    }

    function toggleItem(item) {
      if (item.classList.contains('is-open')) {
        closeItem(item);
      } else {
        openItem(item);
      }
    }

    items.forEach((item) => {
      const trigger = item.querySelector('.help-accordion-trigger');
      if (!trigger) return;
      trigger.addEventListener('click', () => toggleItem(item));
    });

    const hash = window.location.hash.replace('#', '');
    if (hash) {
      const target = document.getElementById(hash);
      if (target && target.classList.contains('help-accordion-item')) {
        openItem(target);
        requestAnimationFrame(() => {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    }
  });
})();
