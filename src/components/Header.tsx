import Link from "next/link";

const navLinks = [
  { href: "/", label: "Главная" },
  { href: "/catalog", label: "Каталог" },
  { href: "/orders", label: "Мои заказы" },
  { href: "/cart", label: "Корзина" },
  { href: "/profile", label: "Профиль" },
];

export default function Header() {
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href="/"
          className="text-xl font-bold tracking-tight text-neutral-800"
        >
          DEKORO
        </Link>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-neutral-600">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="transition-colors hover:text-[#0F766E]"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
