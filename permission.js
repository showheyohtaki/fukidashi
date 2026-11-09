// サイドパネルからはマイクの許可を求められないため、このタブで一度だけ許可をもらう。
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((s) => {
    s.getTracks().forEach((t) => t.stop());
    document.getElementById("msg").textContent = "許可できました。このタブを閉じて、パネルで「開始」を押してください。";
  })
  .catch((e) => {
    document.getElementById("msg").textContent = `許可されませんでした（${e.name}）。アドレスバー左のアイコンからマイクを許可してください。`;
  });
