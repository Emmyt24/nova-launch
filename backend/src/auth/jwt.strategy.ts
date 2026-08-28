import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { JwtPayloadDto } from "../dto/auth.dto";
import { TokenService } from "../token.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(
    private readonly configService: ConfigService,
    private readonly tokenService: TokenService
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("JWT_ACCESS_SECRET"),
      passReqToCallback: false,
    });
  }

  async validate(payload: JwtPayloadDto): Promise<JwtPayloadDto> {
    if (payload.type !== "access") {
      throw new UnauthorizedException("Invalid token type");
    }

    if (payload.jti && (await this.tokenService.isRevoked(payload.jti))) {
      throw new UnauthorizedException("Token has been revoked");
    }

    return payload;
  }
}
