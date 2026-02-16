.PHONY: build up down logs shell ssh clean docker-test

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

shell:
	docker exec -it -u claude claude-box bash

ssh:
	ssh -p 2222 claude@localhost

clean:
	docker compose down -v --rmi local

docker-test:
	docker exec -u claude claude-box docker run --rm hello-world
