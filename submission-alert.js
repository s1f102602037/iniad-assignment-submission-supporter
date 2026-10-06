(() => {
  "use strict";

  // Native alerts are outside the DOM and must be observed in the page's world.
  // Preserve the original dialog, arguments, receiver and return value.
  const originalAlert = window.alert;
  const dispatch = document.dispatchEvent.bind(document);
  const SuccessEvent = Event;
  const savedMessage = /^(?:すべての回答を保存しました。[\s]*(?:All your answers have been saved\.)?|All your answers have been saved\.)$/;

  window.alert = function (...args) {
    if (typeof args[0] === "string" && savedMessage.test(args[0].trim())) {
      try {
        // Signal before alert blocks; the panel can paint after the user closes it.
        dispatch(new SuccessEvent("iniad-moocs-answers-saved"));
      } catch {
        // Extension failures must never prevent the site's original dialog.
      }
    }
    return Reflect.apply(originalAlert, this, args);
  };
})();
