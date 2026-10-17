import { useEffect } from "react";
import { Icon, Logo } from "./ui";
import { ThemeToggle, useSiteBrand } from "./public-theme";

export function MoonwaterLandscape({
  id,
  compact = false,
}: {
  id: string;
  compact?: boolean;
}) {
  return (
    <svg
      className={`moonwater-landscape${compact ? " compact" : ""}`}
      viewBox="0 0 1600 860"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-mist`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="mist-stop" />
          <stop offset="1" className="mist-clear" />
        </linearGradient>
        <radialGradient id={`${id}-moon`}>
          <stop className="moon-center" />
          <stop offset="1" className="moon-edge" />
        </radialGradient>
      </defs>
      <circle className="moon-halo" cx="1230" cy="185" r="132" />
      <circle fill={`url(#${id}-moon)`} cx="1230" cy="185" r="67" />
      <path
        className="mountain far"
        d="M0 535 70 454 123 481 215 360 274 424 338 399 434 487 515 462 610 543 716 506 815 545 960 422 1048 456 1155 333 1201 385 1294 314 1388 424 1501 345 1600 430V860H0Z"
      />
      <path
        className="mountain distant"
        d="M0 591C80 573 138 420 221 464S334 538 392 505 472 560 546 589 636 622 706 630C839 653 918 528 991 560S1076 466 1151 485 1280 536 1337 464 1471 498 1600 447V860H0Z"
      />
      <path
        className="mountain middle"
        d="M0 589C62 510 109 572 157 551S229 614 294 603 397 667 474 680L707 721 1088 699C1193 650 1221 556 1280 575S1393 512 1443 540 1527 488 1600 526V860H0Z"
      />
      <path
        className="ridge-highlight"
        d="M0 588C64 510 110 572 157 551S229 614 294 603 397 667 474 680M1088 699C1193 650 1221 556 1280 575S1393 512 1443 540 1527 488 1600 526"
      />
      <path
        className="water-surface"
        d="M320 690Q800 644 1290 690L1460 860H130Z"
      />
      <path
        className="water-line"
        d="M563 712Q817 690 1110 708M395 755Q800 727 1208 750M556 785Q815 771 1061 783M695 817Q818 811 958 818M1019 653l175-2m-141 9 98-1m-77 8 53-1"
      />
      <path
        className="mountain near"
        d="M0 677C68 634 114 654 160 709S244 745 303 783 426 797 497 860H0ZM1600 639C1520 664 1510 722 1433 740S1326 794 1260 860H1600Z"
      />
      <rect y="410" width="1600" height="330" fill={`url(#${id}-mist)`} />
      <g className="landscape-reeds" fill="none" strokeLinecap="round">
        <path d="M47 860Q90 773 66 687M51 836Q105 796 135 733M50 834Q35 777 15 752M62 815Q104 814 153 778" />
        <path d="M65 725q-40-40-31-61 35 20 31 61Zm7 44q42-47 55-46-10 33-55 46Zm-4 31q-45-31-47-48 34 8 47 48Zm21 14q41-34 56-31-17 29-56 31Z" />
      </g>
      <path className="landscape-birds" d="m1048 277 11-3 9 6m-62 25 9-2 6 5" />
    </svg>
  );
}
export function Welcome() {
  const brand = useSiteBrand();
  useEffect(() => {
    document.title = `${brand.name} · 月白水碧，静候好故事`;
  }, [brand.name]);
  return (
    <div className="public-app welcome-app">
      <a className="skip-link" href="#welcome-main">
        跳到欢迎内容
      </a>
      <header className="welcome-header public-container">
        <Logo brand={brand} />
        <div className="welcome-header-note">一方山水 · 一间放映室</div>
        <ThemeToggle />
      </header>
      <main id="welcome-main">
        <section className="welcome-hero" aria-labelledby="welcome-title">
          <MoonwaterLandscape id="welcome" />
          <div className="welcome-content public-container">
            <span className="welcome-eyebrow">
              <span /> MOONWATER CINEMA
            </span>
            <p className="welcome-poem">月映清波，玉色入怀。</p>
            <h1 id="welcome-title">
              好故事，
              <br />
              值得慢慢看。
            </h1>
            <p className="welcome-intro">
              在日常之外，留一段安静的时光。
              <br />
              让喜欢的故事，与你在此相逢。
            </p>
            <a className="welcome-cta" href="/video">
              进入放映室 <Icon name="arrow" size={20} />
            </a>
            <div className="welcome-assurances">
              <span>
                <Icon name="play" size={15} />
                随心观看
              </span>
              <span>
                <Icon name="clock" size={15} />
                接着上次
              </span>
              <span>
                <Icon name="shield" size={15} />
                无需注册
              </span>
            </div>
          </div>
          <span className="welcome-landscape-caption">山水之间 / 故事之中</span>
        </section>
        <section
          className="welcome-details public-container"
          aria-label="属于你的观影时光"
        >
          <div className="welcome-detail-intro">
            <span className="eyebrow">A MOMENT FOR YOURSELF</span>
            <h2>
              给心情，
              <br />
              一处栖息。
            </h2>
          </div>
          <div className="welcome-detail">
            <span className="welcome-detail-number">01</span>
            <h3>随时，走进故事</h3>
            <p>
              找到喜欢的影片，按下播放。
              <br />
              把这一刻，留给自己。
            </p>
          </div>
          <div className="welcome-detail">
            <span className="welcome-detail-number">02</span>
            <h3>从上次，继续相遇</h3>
            <p>
              在当前浏览器里保留观看进度，
              <br />
              让未完的故事有迹可循。
            </p>
          </div>
          <div className="welcome-detail">
            <span className="welcome-detail-number">03</span>
            <h3>简单，自在地观看</h3>
            <p>
              不必注册，轻松进入放映室。
              <br />
              在熟悉的屏幕前，慢慢看。
            </p>
          </div>
        </section>
      </main>
      <footer className="welcome-footer public-container">
        <Logo small brand={brand} />
        <span>把好故事，留给慢慢看的你。</span>
        <span>月白水碧 · {brand.name}</span>
      </footer>
    </div>
  );
}
