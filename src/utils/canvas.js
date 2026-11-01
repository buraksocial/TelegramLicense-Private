const { createCanvas } = require('canvas');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { t } = require('./i18n');

async function generateRankImage(lang, userRank, nextRank, totalPurchases) {
  // Create a 800x400 canvas
  const canvas = createCanvas(800, 400);
  const ctx = canvas.getContext('2d');

  // Helper to draw rounded rectangle
  function fillRoundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }

  // Background
  const gradient = ctx.createLinearGradient(0, 0, 800, 400);
  gradient.addColorStop(0, '#141E30');
  gradient.addColorStop(1, '#243B55');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 800, 400);

  // Styling
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';

  // Title
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText(t(lang, 'rank_title') || '🏆 RANK & VIP STATUS 🏆', 400, 60);

  // Current Rank
  ctx.font = 'bold 30px sans-serif';
  ctx.fillStyle = '#FFD700'; // Gold
  const currentRankName = userRank ? userRank.name : (t(lang, 'no_rank') || 'No Rank');
  const currRankTxt = (t(lang, 'current_rank') || 'Current Rank: ') + currentRankName;
  ctx.fillText(currRankTxt, 400, 150);

  // Benefits
  ctx.font = '24px sans-serif';
  ctx.fillStyle = '#E0E0E0';
  let benefitText = t(lang, 'benefits_none') || 'Benefits: None';
  if (userRank) {
    if (userRank.discount_percent > 0) {
      benefitText = (t(lang, 'benefits_discount') || 'Benefits: {pct}% global discount!').replace('{pct}', userRank.discount_percent);
    } else {
      benefitText = t(lang, 'benefits_special') || 'Benefits: Special prices on select products!';
    }
  }
  ctx.fillText(benefitText, 400, 200);

  // Progress to next rank
  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#B0BEC5';
  ctx.fillText((t(lang, 'total_purchases_lbl') || 'Total Purchases: ') + totalPurchases, 400, 280);

  if (nextRank) {
    const needed = nextRank.min_purchases - totalPurchases;
    const nextRankTxt = (t(lang, 'next_rank_needed') || 'Next Rank: {name} (Need {num} more purchases)').replace('{name}', nextRank.name).replace('{num}', needed);
    ctx.fillText(nextRankTxt, 400, 320);
    
    // Progress bar
    const barWidth = 400;
    const barHeight = 20;
    const barX = 200;
    const barY = 340;
    
    ctx.fillStyle = '#37474F';
    fillRoundRect(ctx, barX, barY, barWidth, barHeight, 10);
    
    const prevMin = userRank ? userRank.min_purchases : 0;
    const progress = (totalPurchases - prevMin) / (nextRank.min_purchases - prevMin);
    
    ctx.fillStyle = '#00E676';
    fillRoundRect(ctx, barX, barY, barWidth * Math.max(0, Math.min(1, progress)), barHeight, 10);
    
    // Draw percentage text inside the progress bar
    const percentText = Math.floor(progress * 100) + '%';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(percentText, barX + (barWidth / 2), barY + 15);
  } else if (userRank) {
    ctx.fillText(t(lang, 'highest_rank_reached') || 'You have reached the highest rank! 🎉', 400, 320);
  }

  return canvas.toBuffer('image/png');
}

async function generateStatsChart(daily, monthly, total) {
  const width = 800;
  const height = 400;
  
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ 
    width, height,
    chartCallback: (ChartJS) => {
      ChartJS.defaults.color = '#E0E0E0';
      ChartJS.defaults.font.family = 'sans-serif';
    }
  });
  
  const configuration = {
    type: 'bar',
    data: {
      labels: ['Günlük (Daily)', 'Aylık (Monthly)', 'Toplam (Total)'],
      datasets: [
        {
          label: 'Gelir (Income) USD',
          data: [daily.income, monthly.income, total.income],
          backgroundColor: 'rgba(75, 192, 192, 0.7)',
          borderColor: 'rgba(75, 192, 192, 1)',
          borderWidth: 2,
          borderRadius: 5
        },
        {
          label: 'Gider (Expense) USD',
          data: [daily.expense, monthly.expense, total.expense],
          backgroundColor: 'rgba(255, 99, 132, 0.7)',
          borderColor: 'rgba(255, 99, 132, 1)',
          borderWidth: 2,
          borderRadius: 5
        },
        {
          label: 'Kâr (Profit) USD',
          data: [daily.profit, monthly.profit, total.profit],
          backgroundColor: 'rgba(54, 162, 235, 0.7)',
          borderColor: 'rgba(54, 162, 235, 1)',
          borderWidth: 2,
          borderRadius: 5
        }
      ]
    },
    options: {
      layout: {
        padding: 20
      },
      plugins: {
        title: {
          display: true,
          text: 'Detaylı Satış İstatistikleri / Detailed Statistics',
          font: { size: 24, weight: 'bold' },
          color: '#FFFFFF'
        },
        legend: { display: true, labels: { font: { size: 14 } } }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.1)' },
          ticks: {
            callback: function(value) {
              return '$' + value;
            }
          }
        },
        x: {
          grid: { display: false },
          ticks: { font: { size: 16 } }
        }
      }
    },
    plugins: [{
      id: 'custom_canvas_background_color',
      beforeDraw: (chart) => {
        const ctx = chart.canvas.getContext('2d');
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        const grad = ctx.createLinearGradient(0,0,0,height);
        grad.addColorStop(0, '#141E30');
        grad.addColorStop(1, '#243B55');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, chart.width, chart.height);
        ctx.restore();
      }
    }]
  };
  
  return await chartJSNodeCanvas.renderToBuffer(configuration);
}


module.exports = {
  generateRankImage,
  generateStatsChart
};
