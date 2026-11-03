// 获取当前热门电影：优先豆瓣「热门」榜，失败时用内置片单兜底，保证演示不中断。
const FALLBACK = ['哪吒之魔童闹海', '流浪地球2', '封神第一部', '热辣滚烫', '抓娃娃'];

export async function getHotMovies() {
  try {
    const url = 'https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&page_limit=10&page_start=0';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36', Referer: 'https://movie.douban.com/' },
    });
    const data = await res.json();
    const list = (data.subjects || []).map(s => ({ title: s.title, rate: s.rate }));
    if (list.length) return { source: '豆瓣热门榜', list };
  } catch {
    // 网络或接口变化时走兜底
  }
  return { source: '内置热门片单', list: FALLBACK.map(title => ({ title, rate: '' })) };
}
